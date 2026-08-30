import { createHash } from "node:crypto";
import path from "node:path";
import {
  claudeLifecycleCompatibilityProfile,
  claudeRuntimeCompatibilityWarning,
  claudeRuntimeLifecycleCompatibilityProfile,
  profiledClaudeNativeStatusPanelFields
} from "./claude-lifecycle-compatibility.js";
import { redactString } from "./runtime-log.js";
import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalApprovalInspection,
  TerminalApprovalPolicyEvidence,
  TerminalDurableCompletionRequest,
  TerminalNativeInspectionCapabilities,
  TerminalNativeInspectionEvidenceInventoryEntry,
  TerminalNativeInspectionField,
  TerminalNativeInspectionObservation,
  TerminalNativeInspectionObservationRequest,
  TerminalNativeInspectionOperation,
  TerminalNativeInspectionPlan,
  TerminalProcessSnapshot,
  TerminalRuntimeIdentity,
  TerminalScreenInspection,
  TerminalScreenInspectionOptions,
  TerminalThreadLifecycleCapabilities,
  TerminalThreadLifecycleObservation,
  TerminalThreadLifecycleObservationRequest,
  TerminalThreadLifecycleObserver,
  TerminalThreadLifecycleOperation,
  TerminalThreadLifecyclePlan
} from "./terminal-agent-adapter.js";
import {
  normalizeTerminalApprovalPromptRegion,
  terminalApprovalPromptEvidence
} from "./terminal-agent-adapter.js";
import { isExactNativeThreadId } from "./managed-session.js";

export type ClaudeProcessKind = "claude_cli";

/** A row returned by `claude agents --json --all`. Unknown fields are intentionally ignored. */
export interface ClaudeAgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  startedAt?: number;
  status?: string;
  waitingFor?: string;
}

export interface CreateClaudeTerminalAgentAdapterOptions {
  /**
   * A point-in-time `claude agents --json --all` snapshot. Rows are joined only by an exact PID;
   * names, cwd values, and fuzzy command matches are never used as process identity.
   */
  agentRows?: readonly ClaudeAgentRow[];
  /** Read-only local transcript detector used for durable completion. */
  detectDurableCompletion?: NonNullable<
    TerminalAgentAdapter<ClaudeProcessKind>["detectDurableCompletion"]
  >;
  /**
   * Local transcript evidence for the one pending Bash tool use in the current
   * managed turn. The adapter intersects it with the current strict permission
   * screen before exposing any executor-local policy authority.
   */
  detectPendingApproval?: (
    request: TerminalDurableCompletionRequest
  ) => ClaudePendingApprovalEvidence | undefined;
}

export interface ClaudePendingApprovalEvidence {
  source: "claude_transcript";
  kind: "run_command";
  command: string;
  cwd: string;
  toolName: "Bash";
  toolUseId: string;
  promptUuid: string;
  assistantUuid: string;
  claudeVersion: string;
  transcriptFileId: string;
  commandSha256: string;
  evidenceFingerprint: string;
  observedEndOffsetBytes: number;
}

const CLAUDE_SUBCOMMANDS = new Set([
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "project",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade"
]);

const NON_INTERACTIVE_FLAGS = new Set([
  "-h",
  "--help",
  "-p",
  "--print",
  "-v",
  "--version",
  "--bg",
  "--background"
]);

const OPTIONS_WITH_VALUES = new Set([
  "--add-dir",
  "--agent",
  "--agents",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--betas",
  "--debug-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--effort",
  "--fallback-model",
  "--file",
  "--from-pr",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--tools"
]);

const OPTIONAL_VALUE_OPTIONS = new Set([
  "-d",
  "--debug",
  "--prompt-suggestions",
  "--remote-control",
  "-w",
  "--worktree"
]);

const CLAUDE_SCREEN_TAIL_LINES = 48;
const CLAUDE_EXCERPT_LINES = 80;
const CLAUDE_PERMISSION_DETAIL_LENGTH = 600;
const CLAUDE_AUTO_APPROVAL_COMMAND_LENGTH = 2000;
const CLAUDE_NATIVE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
/**
 * On each verified Claude TUI profile, the exact `/status` composer and its
 * closed completion list remained byte-stable across an 80 ms capture interval
 * and one subsequent Enter opened the Status panel. This is a Claude-local
 * single-line boundary; it deliberately does not reuse Codex's 121 ms burst
 * paste boundary.
 */
export const CLAUDE_NATIVE_INSPECTION_COMPOSER_STABLE_MS = 80;
const CLAUDE_STATUS_PANEL_HEADER =
  /^\s*Settings\s+Status\s+Config\s+Usage\s+Stats\s*$/u;
const CLAUDE_STATUS_PANEL_FOOTER = /^\s*Esc to cancel\s*$/u;
const CLAUDE_STATUS_PANEL_DIVIDER = /^\s*[─━]{8,}\s*$/u;
const CLAUDE_STATUS_PANEL_FIELD = /^\s{0,4}([^:]{1,64}):\s+(.{1,1024})\s*$/u;
const CLAUDE_STATUS_PANEL_MAX_SCAN_LINES = 512;
const CLAUDE_STATUS_PANEL_MAX_LINES = 48;
const CLAUDE_STATUS_PANEL_MAX_REGION_LENGTH = 8_192;
const CLAUDE_STATUS_PANEL_MAX_FIELDS = 24;
const CLAUDE_STATUS_PANEL_MAX_FIELD_VALUE_LENGTH = 512;
const CLAUDE_STATUS_PANEL_MAX_EXCERPT_LENGTH = 4_000;
const CLAUDE_STATUS_PANEL_MAX_EVIDENCE_ENTRIES = 24;
const PROFILED_CLAUDE_STATUS_PANEL_FIELDS = new Set(
  profiledClaudeNativeStatusPanelFields()
);
const CLAUDE_STATUS_PANEL_SENSITIVE_FIELDS = new Set([
  "Session name",
  "Peer address",
  "Auth token"
]);
const NATIVE_INSPECTION_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const ANSI_ESCAPE_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;

export function createClaudeTerminalAgentAdapter(
  options: CreateClaudeTerminalAgentAdapterOptions = {}
): TerminalAgentAdapter<ClaudeProcessKind> {
  const agentRows = options.agentRows ?? [];
  const transcriptCompletionDetector = options.detectDurableCompletion;
  const transcriptApprovalDetector = options.detectPendingApproval;
  const durableCompletion =
    transcriptCompletionDetector !== undefined;
  const lifecycleObserver: TerminalThreadLifecycleObserver = (
    requestOrScreen: TerminalThreadLifecycleObservationRequest | string,
    legacyOperation?: TerminalThreadLifecycleOperation
  ) => typeof requestOrScreen === "string"
    ? observeClaudeThreadLifecycle(
        requestOrScreen,
        legacyOperation ?? { kind: "new_thread" },
        agentRows
      )
    : observeClaudeThreadLifecycle(requestOrScreen, undefined, agentRows);
  return {
    agent: "claude",
    displayName: "Claude Code",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      // A visible idle prompt is not durable proof that the requested turn completed.
      screenCompletion: false,
      durableCompletion,
      cancellation: true
    },
    cancelKeys: ["Escape"],
    classifyProcess(snapshot) {
      return classifyClaudeProcess(snapshot, agentRows);
    },
    inspectScreen(screenOptions) {
      return transcriptApprovalScreenInspection(
        inspectClaudeScreen(screenOptions),
        screenOptions,
        transcriptApprovalDetector
      );
    },
    probeThreadLifecycle: probeClaudeThreadLifecycle,
    planThreadLifecycle: planClaudeThreadLifecycle,
    observeThreadLifecycle: lifecycleObserver,
    probeNativeInspection: probeClaudeNativeInspection,
    planNativeInspection: planClaudeNativeInspection,
    observeNativeInspection: observeClaudeNativeInspection,
    ...(durableCompletion
      ? {
          async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
            return transcriptCompletionDetector?.(request);
          }
        }
      : {})
  };
}

export function probeClaudeNativeInspection(
  agentVersion: string | undefined
): TerminalNativeInspectionCapabilities {
  const profile = claudeRuntimeLifecycleCompatibilityProfile(agentVersion);
  if (!profile) {
    return {
      status: "unknown",
      statusInspection: false,
      reason: "the running Claude Code version could not be verified"
    };
  }
  const verified = claudeLifecycleCompatibilityProfile(agentVersion) !==
    undefined;
  const compatibilityWarning = claudeRuntimeCompatibilityWarning(agentVersion);
  return {
    status: "supported",
    agentVersion,
    behaviorProfile: profile.nativeInspectionBehaviorProfile,
    versionCompatibility: verified ? "verified" : "unverified",
    ...(compatibilityWarning ? { compatibilityWarning } : {}),
    statusInspection: true,
    reason: verified
      ? "Claude Code /status native inspection is supported by the verified version"
      : "Claude Code /status native inspection will use the unverified compatibility profile"
  };
}

export function planClaudeNativeInspection(
  operation: TerminalNativeInspectionOperation,
  capabilities: TerminalNativeInspectionCapabilities
): TerminalNativeInspectionPlan {
  const profile = claudeRuntimeLifecycleCompatibilityProfile(
    capabilities.agentVersion
  );
  if (
    operation.kind !== "status" ||
    capabilities.status !== "supported" ||
    capabilities.statusInspection !== true ||
    !profile ||
    capabilities.behaviorProfile !== profile.nativeInspectionBehaviorProfile
  ) {
    throw new Error(capabilities.reason);
  }
  return {
    operation,
    behaviorProfile: profile.nativeInspectionBehaviorProfile,
    command: "/status",
    effect: "read_only",
    requiresIdle: true,
    composer: {
      kind: "exact",
      minimumStableMs: profile.nativeInspectionComposerStableMs,
      maximumSettleMs: profile.nativeInspectionComposerSettleTimeoutMs
    },
    expectedResult: {
      kind: "native_status",
      presentation: "modal",
      dismissal: {
        keys: ["Escape"],
        expected: "idle_empty_composer"
      }
    }
  };
}

export function observeClaudeNativeInspection(
  request: TerminalNativeInspectionObservationRequest
): TerminalNativeInspectionObservation {
  const rawScreen = request.screen ?? "";
  const rawScreenFingerprint = fingerprintClaudeNativeInspection(rawScreen);
  const screen = normalizeClaudeNativeInspectionScreen(rawScreen);
  const screenFingerprint = fingerprintClaudeNativeInspection(screen);
  const inventory = claudeStatusPanelEvidenceInventory(screen);
  if (inventory.status === "ambiguous") {
    return {
      status: "ambiguous",
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason: inventory.reason
    };
  }
  const baselineError = validateClaudeStatusEvidenceInventory(
    request.preEnterEvidenceInventory
  );
  if (baselineError) {
    return {
      status: "ambiguous",
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason: baselineError
    };
  }
  if (
    request.previousScreenFingerprint !== undefined &&
    (
      request.previousScreenFingerprint === rawScreenFingerprint ||
      request.previousScreenFingerprint === screenFingerprint
    )
  ) {
    return {
      status: "stale",
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason: "the Claude screen did not change after the native inspection command"
    };
  }

  const parsed = parseCurrentClaudeStatusPanel(screen);
  if (parsed.status !== "observed") {
    return {
      status: parsed.status,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason: parsed.reason
    };
  }
  const evidenceFingerprint = fingerprintClaudeNativeInspection(parsed.region);
  if (request.preEnterEvidenceInventory !== undefined) {
    const priorOccurrences = request.preEnterEvidenceInventory.find((entry) =>
      entry.evidenceFingerprint === evidenceFingerprint
    )?.occurrenceCount ?? 0;
    const currentOccurrences = inventory.entries.find((entry) =>
      entry.evidenceFingerprint === evidenceFingerprint
    )?.occurrenceCount ?? 0;
    if (currentOccurrences <= priorOccurrences) {
      return {
        status: "stale",
        nativeThreadId: parsed.nativeThreadId,
        observedAgentVersion: parsed.agentVersion,
        evidence: "claude_status_panel",
        evidenceFingerprint,
        screenFingerprint,
        evidenceInventory: inventory.entries,
        reason:
          "the Claude Status panel did not add fresh exact evidence after Enter"
      };
    }
  }
  if (!claudeRuntimeLifecycleCompatibilityProfile(parsed.agentVersion)) {
    return {
      status: "mismatch",
      nativeThreadId: parsed.nativeThreadId,
      observedAgentVersion: parsed.agentVersion,
      evidenceFingerprint,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason: `Claude /status reported invalid version ${parsed.agentVersion}`
    };
  }
  if (
    request.expectedAgentVersion !== undefined &&
    parsed.agentVersion !== request.expectedAgentVersion
  ) {
    return {
      status: "mismatch",
      nativeThreadId: parsed.nativeThreadId,
      observedAgentVersion: parsed.agentVersion,
      evidenceFingerprint,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason:
        `Claude /status reported version ${parsed.agentVersion}, not the ` +
        `verified running version ${request.expectedAgentVersion}`
    };
  }
  if (!isExactNativeThreadId(request.expectedNativeThreadId)) {
    return {
      status: "mismatch",
      nativeThreadId: parsed.nativeThreadId,
      observedAgentVersion: parsed.agentVersion,
      evidenceFingerprint,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason:
        "Claude native status inspection requires an exact claude agents Session identity"
    };
  }
  if (
    parsed.nativeThreadId !== request.expectedNativeThreadId.toLowerCase()
  ) {
    return {
      status: "mismatch",
      nativeThreadId: parsed.nativeThreadId,
      observedAgentVersion: parsed.agentVersion,
      evidenceFingerprint,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason:
        `Claude /status reported ${parsed.nativeThreadId}, not the exact ` +
        `claude agents Session ${request.expectedNativeThreadId.toLowerCase()}`
    };
  }
  if (
    request.expectedCwd !== undefined &&
    normalizeLifecyclePath(parsed.cwd) !==
      normalizeLifecyclePath(request.expectedCwd)
  ) {
    return {
      status: "mismatch",
      nativeThreadId: parsed.nativeThreadId,
      observedAgentVersion: parsed.agentVersion,
      evidenceFingerprint,
      screenFingerprint,
      evidenceInventory: inventory.entries,
      reason:
        `Claude /status cwd ${parsed.cwd} does not match the verified pane cwd`
    };
  }

  return {
    status: "observed",
    nativeThreadId: parsed.nativeThreadId,
    observedAgentVersion: parsed.agentVersion,
    evidence: "claude_status_panel",
    evidenceFingerprint,
    screenFingerprint,
    evidenceInventory: inventory.entries,
    result: {
      kind: "native_status",
      nativeThreadId: parsed.nativeThreadId,
      agentVersion: parsed.agentVersion,
      fields: parsed.fields,
      excerpt: claudeNativeStatusExcerpt(parsed.fields)
    }
  };
}

export function probeClaudeThreadLifecycle(
  agentVersion: string | undefined
): TerminalThreadLifecycleCapabilities {
  const profile = claudeRuntimeLifecycleCompatibilityProfile(agentVersion);
  if (!profile) {
    return {
      status: "unknown",
      newThread: false,
      resumeExact: false,
      reason: "the running Claude Code version could not be verified"
    };
  }
  const verified = claudeLifecycleCompatibilityProfile(agentVersion) !==
    undefined;
  const compatibilityWarning = claudeRuntimeCompatibilityWarning(agentVersion);
  return {
    status: "supported",
    agentVersion,
    behaviorProfile: profile.lifecycleBehaviorProfile,
    versionCompatibility: verified ? "verified" : "unverified",
    ...(compatibilityWarning ? { compatibilityWarning } : {}),
    newThread: true,
    resumeExact: true,
    candidateDiscovery: true,
    reason: verified
      ? "Claude Code /clear and exact /resume are supported by the verified version"
      : "Claude Code /clear and exact /resume will use the unverified compatibility profile"
  };
}

export function planClaudeThreadLifecycle(
  operation: TerminalThreadLifecycleOperation,
  capabilities: TerminalThreadLifecycleCapabilities
): TerminalThreadLifecyclePlan {
  const behaviorProfile = claudeRuntimeLifecycleCompatibilityProfile(
    capabilities.agentVersion
  )?.lifecycleBehaviorProfile;
  if (
    capabilities.status !== "supported" ||
    !behaviorProfile ||
    capabilities.behaviorProfile !== behaviorProfile
  ) {
    throw new Error(capabilities.reason);
  }
  if (operation.kind === "new_thread") {
    if (!capabilities.newThread) {
      throw new Error("this Claude Code version does not support verified new-thread control");
    }
    return {
      operation,
      behaviorProfile,
      steps: [{
        kind: "transition",
        command: "/clear",
        effect: "thread_transition",
        requiresIdle: true
      }],
      command: "/clear",
      expectedResult: { kind: "different_native_thread" }
    };
  }
  if (!capabilities.resumeExact) {
    throw new Error("this Claude Code version does not support verified exact resume control");
  }
  if (!isExactNativeThreadId(operation.nativeThreadId)) {
    throw new Error("Claude Code resume requires a complete native thread UUID");
  }
  return {
    operation,
    behaviorProfile,
    steps: [{
      kind: "transition",
      command: `/resume ${operation.nativeThreadId}`,
      effect: "thread_transition",
      requiresIdle: true
    }],
    command: `/resume ${operation.nativeThreadId}`,
    expectedResult: {
      kind: "exact_native_thread",
      nativeThreadId: operation.nativeThreadId
    }
  };
}

export function observeClaudeThreadLifecycle(
  request: TerminalThreadLifecycleObservationRequest,
  legacyOperation?: undefined,
  fallbackAgentRows?: readonly ClaudeAgentRow[]
): TerminalThreadLifecycleObservation;
/** @deprecated Claude lifecycle identity requires a typed agents-row request. */
export function observeClaudeThreadLifecycle(
  screen: string,
  operation: TerminalThreadLifecycleOperation,
  fallbackAgentRows?: readonly ClaudeAgentRow[]
): TerminalThreadLifecycleObservation;
export function observeClaudeThreadLifecycle(
  requestOrScreen: TerminalThreadLifecycleObservationRequest | string,
  legacyOperation?: TerminalThreadLifecycleOperation,
  fallbackAgentRows: readonly ClaudeAgentRow[] = []
): TerminalThreadLifecycleObservation {
  if (typeof requestOrScreen === "string") {
    return {
      status: "missing",
      reason:
        "Claude lifecycle identity is not available from screen text; exact agents JSON is required"
    };
  }
  const request = requestOrScreen;
  const pid = Number(request.pid);
  const startedAt = Number(request.processStartedAt);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0
  ) {
    return {
      status: "missing",
      reason: "Claude lifecycle observation requires exact PID and startedAt identity"
    };
  }
  const rows = request.agentRows ?? fallbackAgentRows;
  const matches = rows.filter((row) => Number(row.pid) === pid);
  if (matches.length === 0) {
    return {
      status: "missing",
      reason: `Claude agents JSON has no row for PID ${pid}`
    };
  }
  if (matches.length !== 1) {
    return {
      status: "ambiguous",
      reason: `Claude agents JSON has ${matches.length} rows for PID ${pid}`
    };
  }
  const row = matches[0];
  const nativeThreadId = nonEmptyString(row.sessionId)?.toLowerCase();
  if (
    row.kind !== "interactive" ||
    !isExactNativeThreadId(nativeThreadId) ||
    Number(row.startedAt) !== startedAt ||
    (
      request.cwd !== undefined &&
      (
        !path.isAbsolute(request.cwd) ||
        typeof row.cwd !== "string" ||
        !path.isAbsolute(row.cwd) ||
        normalizeLifecyclePath(row.cwd) !== normalizeLifecyclePath(request.cwd)
      )
    )
  ) {
    return {
      status: "mismatch",
      nativeThreadId,
      evidence: "claude_agents_exact_pid",
      reason: "Claude agents JSON does not match the expected interactive process incarnation"
    };
  }
  const observed: TerminalThreadLifecycleObservation = {
    status: "observed",
    nativeThreadId,
    evidence: "claude_agents_exact_pid",
    idle: isClaudeAgentIdleState(row)
  };
  if (request.phase === "before") {
    return observed;
  }
  if (!isClaudeAgentIdleState(row)) {
    return {
      ...observed,
      status: "mismatch",
      reason: `Claude agents JSON reports ${row.status ?? "unknown"}, not idle`
    };
  }
  if (request.operation.kind === "new_thread") {
    if (!isExactNativeThreadId(request.beforeNativeThreadId)) {
      return {
        ...observed,
        status: "mismatch",
        reason: "a verified before-session UUID is required for Claude /clear"
      };
    }
    return nativeThreadId === request.beforeNativeThreadId.toLowerCase()
      ? {
          ...observed,
          status: "mismatch",
          reason: "Claude /clear did not change the sessionId"
        }
      : { ...observed, status: "verified" };
  }
  const expected = (
    request.expectedNativeThreadId ?? request.operation.nativeThreadId
  ).toLowerCase();
  if (!isExactNativeThreadId(expected)) {
    return {
      ...observed,
      status: "mismatch",
      reason: "Claude resume postcondition requires an exact target UUID"
    };
  }
  return nativeThreadId === expected
    ? { ...observed, status: "verified" }
    : {
        ...observed,
        status: "mismatch",
        reason: `Claude resumed ${nativeThreadId}, not the requested native thread ${expected}`
      };
}

/**
 * Claude Code 2.1.251 can report an input-ready interactive composer as
 * `waiting` without a `waitingFor` reason. A non-empty wait reason remains a
 * real blocked state and must never be promoted to idle.
 */
export function isClaudeAgentIdleState(row: ClaudeAgentRow): boolean {
  const waitingFor = typeof row.waitingFor === "string"
    ? row.waitingFor.trim()
    : "";
  return row.status === "idle" ||
    (row.status === "waiting" && waitingFor.length === 0);
}

type ParsedClaudeStatusPanel =
  | {
      status: "observed";
      region: string;
      agentVersion: string;
      nativeThreadId: string;
      cwd: string;
      fields: readonly TerminalNativeInspectionField[];
    }
  | {
      status: "missing" | "ambiguous";
      reason: string;
    };

function parseCurrentClaudeStatusPanel(
  screen: string
): ParsedClaudeStatusPanel {
  const lines = screen.split("\n").slice(-CLAUDE_STATUS_PANEL_MAX_SCAN_LINES);
  const headers = lines
    .map((line, index) => CLAUDE_STATUS_PANEL_HEADER.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (headers.length === 0) {
    return {
      status: "missing",
      reason: "no current Claude Settings Status panel is visible"
    };
  }
  const headerIndex = headers.at(-1)!;
  if (
    headerIndex === 0 ||
    !CLAUDE_STATUS_PANEL_DIVIDER.test(lines[headerIndex - 1])
  ) {
    return {
      status: "ambiguous",
      reason: "the Claude Status header is not anchored to its exact panel divider"
    };
  }
  const footerIndexes = lines
    .map((line, index) =>
      index > headerIndex &&
      index - headerIndex <= CLAUDE_STATUS_PANEL_MAX_LINES &&
      CLAUDE_STATUS_PANEL_FOOTER.test(line)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (footerIndexes.length !== 1) {
    return {
      status: "ambiguous",
      reason: "the Claude Status panel is incomplete or has ambiguous dismissal markers"
    };
  }
  const footerIndex = footerIndexes[0];
  if (lines.slice(footerIndex + 1).some((line) => line.trim().length > 0)) {
    return {
      status: "missing",
      reason: "the newest Claude Status panel is historical rather than current"
    };
  }
  const regionLines = lines.slice(headerIndex, footerIndex + 1);
  const region = regionLines.join("\n");
  if (
    regionLines.length > CLAUDE_STATUS_PANEL_MAX_LINES ||
    region.length > CLAUDE_STATUS_PANEL_MAX_REGION_LENGTH
  ) {
    return {
      status: "ambiguous",
      reason: "the Claude Status panel exceeds the bounded inspection region"
    };
  }

  const rawFields = new Map<string, string>();
  for (const line of regionLines.slice(1, -1)) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = CLAUDE_STATUS_PANEL_FIELD.exec(line);
    if (!match) {
      return {
        status: "ambiguous",
        reason: "the Claude Status panel contains an unprofiled non-field row"
      };
    }
    const name = match[1].trim();
    const value = match[2].trim();
    if (!PROFILED_CLAUDE_STATUS_PANEL_FIELDS.has(name)) {
      return {
        status: "ambiguous",
        reason: "the Claude Status panel contains an unprofiled field"
      };
    }
    if (rawFields.has(name)) {
      return {
        status: "ambiguous",
        reason: `the Claude Status panel repeats field ${name}`
      };
    }
    rawFields.set(name, value);
  }
  if (rawFields.size === 0 || rawFields.size > CLAUDE_STATUS_PANEL_MAX_FIELDS) {
    return {
      status: "ambiguous",
      reason: "the Claude Status panel has an invalid number of fields"
    };
  }
  const agentVersion = rawFields.get("Version");
  const nativeThreadId = rawFields.get("Session ID")?.toLowerCase();
  const cwd = rawFields.get("cwd");
  const model = rawFields.get("Model");
  if (
    !agentVersion ||
    !isExactNativeThreadId(nativeThreadId) ||
    !cwd ||
    !path.isAbsolute(cwd) ||
    !model
  ) {
    return {
      status: "ambiguous",
      reason:
        "the Claude Status panel lacks exact Version, Session ID, cwd, or Model fields"
    };
  }
  const runtimeProfileFields = new Set(
    claudeRuntimeLifecycleCompatibilityProfile(agentVersion)
      ?.nativeStatusPanelFields ?? []
  );
  const runtimeRequiredValues =
    claudeRuntimeLifecycleCompatibilityProfile(agentVersion)
      ?.nativeStatusPanelRequiredValues ?? {};
  if (
    runtimeProfileFields.size > 0 &&
    [...rawFields.keys()].some((name) => !runtimeProfileFields.has(name))
  ) {
    return {
      status: "ambiguous",
      reason: "the Claude Status panel fields do not match its runtime compatibility profile"
    };
  }
  if (Object.entries(runtimeRequiredValues).some(
    ([name, value]) => rawFields.get(name) !== value
  )) {
    return {
      status: "ambiguous",
      reason: "the Claude Status panel lacks a field value required by its runtime compatibility profile"
    };
  }
  const fields = [...rawFields.entries()].map(([name, rawValue]) => ({
    name,
    value: redactClaudeNativeStatusField(name, rawValue)
      .slice(0, CLAUDE_STATUS_PANEL_MAX_FIELD_VALUE_LENGTH)
  }));
  return {
    status: "observed",
    region,
    agentVersion,
    nativeThreadId,
    cwd,
    fields
  };
}

function claudeStatusPanelEvidenceInventory(screen: string):
  | {
      status: "observed";
      entries: readonly TerminalNativeInspectionEvidenceInventoryEntry[];
    }
  | {
      status: "ambiguous";
      entries: readonly TerminalNativeInspectionEvidenceInventoryEntry[];
      reason: string;
    } {
  const lines = screen.split("\n").slice(-CLAUDE_STATUS_PANEL_MAX_SCAN_LINES);
  const counts = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!CLAUDE_STATUS_PANEL_HEADER.test(lines[index])) {
      continue;
    }
    if (
      index === 0 ||
      !CLAUDE_STATUS_PANEL_DIVIDER.test(lines[index - 1])
    ) {
      return {
        status: "ambiguous",
        entries: [],
        reason: "a Claude Status marker is not anchored to its exact panel divider"
      };
    }
    const footerIndex = lines.findIndex((line, candidateIndex) =>
      candidateIndex > index &&
      candidateIndex - index <= CLAUDE_STATUS_PANEL_MAX_LINES &&
      CLAUDE_STATUS_PANEL_FOOTER.test(line)
    );
    if (footerIndex < 0) {
      return {
        status: "ambiguous",
        entries: [],
        reason: "a Claude Status panel marker has no bounded exact footer"
      };
    }
    const region = lines.slice(index, footerIndex + 1).join("\n");
    if (region.length > CLAUDE_STATUS_PANEL_MAX_REGION_LENGTH) {
      return {
        status: "ambiguous",
        entries: [],
        reason: "a Claude Status panel exceeds the bounded evidence region"
      };
    }
    const fingerprint = fingerprintClaudeNativeInspection(region);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    index = footerIndex;
  }
  const entries = [...counts.entries()].map(([
    evidenceFingerprint,
    occurrenceCount
  ]) => ({ evidenceFingerprint, occurrenceCount }));
  if (entries.length > CLAUDE_STATUS_PANEL_MAX_EVIDENCE_ENTRIES) {
    return {
      status: "ambiguous",
      entries,
      reason: "the Claude Status evidence inventory exceeds its bounded entry count"
    };
  }
  return { status: "observed", entries };
}

function validateClaudeStatusEvidenceInventory(
  inventory:
    readonly TerminalNativeInspectionEvidenceInventoryEntry[] | undefined
): string | undefined {
  if (inventory === undefined) {
    return undefined;
  }
  if (inventory.length > CLAUDE_STATUS_PANEL_MAX_EVIDENCE_ENTRIES) {
    return "the pre-Enter Claude Status evidence inventory is over-bounded";
  }
  const seen = new Set<string>();
  for (const entry of inventory) {
    if (
      !NATIVE_INSPECTION_FINGERPRINT.test(entry.evidenceFingerprint) ||
      !Number.isSafeInteger(entry.occurrenceCount) ||
      entry.occurrenceCount < 1 ||
      seen.has(entry.evidenceFingerprint)
    ) {
      return "the pre-Enter Claude Status evidence inventory is malformed";
    }
    seen.add(entry.evidenceFingerprint);
  }
  return undefined;
}

function redactClaudeNativeStatusField(name: string, value: string): string {
  if (
    CLAUDE_STATUS_PANEL_SENSITIVE_FIELDS.has(name) ||
    /(?:auth|account|email|api\s*key|token|credential|login|organization|user)/iu
      .test(name)
  ) {
    return "[REDACTED]";
  }
  return redactString(value).replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    "[REDACTED EMAIL]"
  );
}

function claudeNativeStatusExcerpt(
  fields: readonly TerminalNativeInspectionField[]
): string {
  return [
    "Claude Code native status",
    ...fields.map((field) => `${field.name}: ${field.value}`)
  ].join("\n").slice(0, CLAUDE_STATUS_PANEL_MAX_EXCERPT_LENGTH);
}

function normalizeClaudeNativeInspectionScreen(screen: string): string {
  return screen
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ");
}

function fingerprintClaudeNativeInspection(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeLifecyclePath(value: unknown): string | undefined {
  const candidate = nonEmptyString(value);
  return candidate === undefined ? undefined : path.resolve(candidate);
}


export const claudeTerminalAgentAdapter = createClaudeTerminalAgentAdapter();

export function classifyClaudeProcess(
  snapshot: TerminalProcessSnapshot,
  agentRows: readonly ClaudeAgentRow[] = []
): ActiveTerminalProcess<ClaudeProcessKind> | undefined {
  const tokens = tokenizeCommand(snapshot.command);
  if (tokens.length === 0 || !isClaudeExecutable(tokens[0])) {
    return undefined;
  }

  const args = tokens.slice(1);
  if (args.some((token) => isNonInteractiveFlag(token))) {
    return undefined;
  }
  if (findClaudeSubcommand(args)) {
    return undefined;
  }

  const agentRow = exactInteractiveAgentRow(snapshot.pid, agentRows);
  if (agentRow === null) {
    return undefined;
  }
  const commandSessionId = extractClaudeSessionId(snapshot.command);
  // `--resume` can retain an old argv value after Claude changes sessions. Exact-PID agent
  // metadata is the current runtime identity and therefore wins on conflict.
  const sessionId = nonEmptyString(agentRow?.sessionId) ?? commandSessionId;
  const cwd = nonEmptyString(snapshot.cwd) ?? nonEmptyString(agentRow?.cwd);
  const confidence = agentRow
    ? "high" as const
    : sessionId
      ? "high" as const
      : cwd
        ? "medium" as const
        : "low" as const;
  const reason = agentRow
    ? "interactive Claude CLI matched an exact PID from claude agents --json --all"
    : sessionId
      ? "interactive Claude CLI command includes a session id"
      : "interactive Claude CLI process without an exact agent metadata row";

  return {
    ...snapshot,
    cwd,
    agent: "claude",
    kind: "claude_cli",
    sessionId,
    confidence,
    reason
  };
}

function isClaudeExecutable(executable: string): boolean {
  if (path.basename(executable) === "claude") {
    return true;
  }
  if (!path.isAbsolute(executable)) {
    return false;
  }

  const segments = executable.split(path.sep);
  const version = segments.at(-1);
  return version !== undefined &&
    CLAUDE_NATIVE_VERSION_PATTERN.test(version) &&
    segments.slice(-5, -1).join("/") === ".local/share/claude/versions";
}

export function extractClaudeSessionId(command: string): string | undefined {
  const args = tokenizeCommand(command).slice(1);
  return optionValue(args, "--session-id") ??
    optionValue(args, "--resume") ??
    shortOptionValue(args, "-r");
}

export function inspectClaudeScreen(
  options: TerminalScreenInspectionOptions
): TerminalScreenInspection {
  const detectedApproval = detectClaudeApprovalPrompt(options.screen);
  const approval = detectedApproval.approvable && !hasManagedClaudeApprovalIdentity(options.runtime)
    ? {
        blocked: true as const,
        approvable: false as const,
        reason: "Claude screen approval requires an active AKK-managed turn with exact process and message identity",
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command,
        cwd: detectedApproval.cwd,
        toolName: detectedApproval.toolName,
        requestDetail: detectedApproval.requestDetail
      }
    : detectedApproval;
  return {
    activity: detectClaudeActivityState(options.screen, approval),
    approval,
    screenExcerpt: claudeScreenExcerpt(options.screen, options.maxExcerptLength ?? 4000)
    // Deliberately no screen completion: idle alone can follow cancellation, errors, or old output.
  };
}

function hasManagedClaudeApprovalIdentity(
  runtime: TerminalRuntimeIdentity | undefined
): boolean {
  return Number.isInteger(runtime?.pid) &&
    Number(runtime?.pid) > 0 &&
    Boolean(nonEmptyString(runtime?.conversationId)) &&
    Boolean(nonEmptyString(runtime?.messageId)) &&
    Boolean(nonEmptyString(runtime?.terminalTarget));
}

function transcriptApprovalScreenInspection(
  screenInspection: TerminalScreenInspection,
  options: TerminalScreenInspectionOptions,
  detector: CreateClaudeTerminalAgentAdapterOptions["detectPendingApproval"]
): TerminalScreenInspection {
  const managedPermissionInspection =
    (options.managedRequest || hasManagedClaudeApprovalIdentity(options.runtime)) &&
    screenInspection.approval.blocked &&
    screenInspection.approval.promptKind === "claude_permission"
      ? privacySafeManagedClaudePermissionInspection(
          screenInspection,
          options.screen,
          options.maxExcerptLength ?? 4000
        )
      : screenInspection;
  if (
    !detector ||
    !options.managedRequest ||
    !hasManagedClaudeApprovalIdentity(options.runtime) ||
    !screenInspection.approval.approvable ||
    screenInspection.approval.action.mode !== "keys"
  ) {
    return managedPermissionInspection;
  }

  let evidence: ClaudePendingApprovalEvidence | undefined;
  try {
    evidence = detector(options.managedRequest);
  } catch {
    // Transcript uncertainty must never remove the user's ability to make the
    // already-validated one-time decision manually.
    return managedPermissionInspection;
  }
  const visibleCommand = claudePermissionVisibleCommandLine(options.screen);
  const policyCommand = evidence
    ? claudePermissionCommandForApproval(evidence.command)
    : undefined;
  const evidenceCwd = evidence && path.isAbsolute(evidence.cwd)
    ? path.resolve(evidence.cwd)
    : undefined;
  const managedRequestCwd =
    nonEmptyString(options.managedRequest.cwd) &&
    path.isAbsolute(options.managedRequest.cwd ?? "")
      ? path.resolve(options.managedRequest.cwd as string)
      : undefined;
  const runtimeCwd =
    nonEmptyString(options.runtime?.cwd) &&
    path.isAbsolute(options.runtime?.cwd ?? "")
      ? path.resolve(options.runtime?.cwd as string)
      : undefined;
  if (
    !evidence ||
    evidence.source !== "claude_transcript" ||
    evidence.kind !== "run_command" ||
    evidence.toolName !== "Bash" ||
    !evidenceCwd ||
    !managedRequestCwd ||
    !runtimeCwd ||
    evidenceCwd !== managedRequestCwd ||
    evidenceCwd !== runtimeCwd ||
    evidence.command.trim() !== evidence.command ||
    policyCommand?.command !== evidence.command ||
    visibleCommand !== evidence.command ||
    sha256Hex(evidence.command) !== evidence.commandSha256 ||
    !isSha256Hex(evidence.evidenceFingerprint) ||
    !nonEmptyString(evidence.toolUseId) ||
    !nonEmptyString(evidence.promptUuid) ||
    !nonEmptyString(evidence.assistantUuid) ||
    !nonEmptyString(evidence.claudeVersion) ||
    !nonEmptyString(evidence.transcriptFileId) ||
    !Number.isSafeInteger(evidence.observedEndOffsetBytes) ||
    evidence.observedEndOffsetBytes <= 0
  ) {
    return managedPermissionInspection;
  }

  const policyEvidence: TerminalApprovalPolicyEvidence = {
    source: "claude_transcript",
    kind: "run_command",
    command: evidence.command,
    cwd: evidenceCwd,
    toolName: "Bash",
    requestId: evidence.toolUseId,
    commandSha256: evidence.commandSha256,
    evidenceFingerprint: evidence.evidenceFingerprint,
    metadata: {
      prompt_uuid: evidence.promptUuid,
      assistant_uuid: evidence.assistantUuid,
      claude_version: evidence.claudeVersion,
      transcript_file_id: evidence.transcriptFileId,
      observed_end_offset_bytes: evidence.observedEndOffsetBytes
    }
  };
  return {
    ...managedPermissionInspection,
    approval: {
      ...screenInspection.approval,
      command: undefined,
      cwd: policyEvidence.cwd,
      toolName: "Bash",
      requestDetail:
        `Verified local Bash request (sha256:${policyEvidence.commandSha256.slice(0, 12)})`,
      policyEvidence,
      action: {
        ...screenInspection.approval.action,
        requestId: policyEvidence.requestId
      }
    },
    screenExcerpt: omitClaudePermissionDetails(
      options.screen,
      policyEvidence.commandSha256,
      options.maxExcerptLength ?? 4000
    )
  };
}

function privacySafeManagedClaudePermissionInspection(
  screenInspection: TerminalScreenInspection,
  screen: string,
  maxExcerptLength: number
): TerminalScreenInspection {
  return {
    ...screenInspection,
    approval: {
      ...screenInspection.approval,
      command: undefined,
      requestDetail:
        "Bash request details omitted; inspect the live terminal pane directly"
    },
    screenExcerpt: omitClaudePermissionDetails(
      screen,
      undefined,
      maxExcerptLength
    )
  };
}

export function claudePermissionCommandForApproval(
  command: string
): { command?: string; display: string } {
  const normalized = command;
  const redacted = redactString(normalized);
  const display = singleLineClaudePermissionValue(redacted, CLAUDE_PERMISSION_DETAIL_LENGTH - 20);
  const policySafe = normalized.length <= CLAUDE_AUTO_APPROVAL_COMMAND_LENGTH && redacted === normalized;
  return {
    ...(policySafe && normalized.trim() ? { command: normalized } : {}),
    display
  };
}

function singleLineClaudePermissionValue(value: string, maxLength: number): string {
  return redactString(value)
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function detectClaudeApprovalPrompt(screen: string): TerminalApprovalInspection {
  const lines = claudeApprovalDetectionLines(screen);
  const markerIndexes = lines
    .map((line, index) => /^\s*Do you want to proceed\?\s*$/iu.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (markerIndexes.length === 0) {
    return {
      blocked: false,
      approvable: false,
      reason: "no current Claude Code permission dialog was detected in the terminal tail"
    };
  }
  if (markerIndexes.length !== 1) {
    return {
      blocked: true,
      approvable: false,
      reason: "multiple Claude Code permission markers are visible; resolve the dialog manually",
      promptKind: "claude_permission"
    };
  }

  const markerIndex = markerIndexes[0];
  const region = lines.slice(markerIndex);
  const lastChoiceLikeIndex = findLastIndex(
    region,
    (line) => /^\s*(?:❯\s*)?[1-4]\.\s*.+?\s*$/u.test(line)
  );
  const newerStateIndex = findLastIndex(region, (line, index) =>
    index > lastChoiceLikeIndex &&
    (isClaudeIdlePromptLine(line) || isClaudeWorkingLine(line))
  );
  const unexpectedTrailingAfterChoices = lastChoiceLikeIndex >= 0 &&
    region.slice(lastChoiceLikeIndex + 1).some((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed) &&
        !isClaudePermissionFooterLine(line) &&
        !/^[─━═╌╍┄┅┈┉\s]+$/u.test(trimmed);
    });
  if (newerStateIndex >= 0) {
    return {
      blocked: false,
      approvable: false,
      reason: "the Claude Code permission dialog appears stale"
    };
  }
  if (unexpectedTrailingAfterChoices) {
    return {
      blocked: true,
      approvable: false,
      reason: "the visible Claude Code permission text does not match the supported current Bash dialog exactly; resolve it manually",
      promptKind: "claude_permission"
    };
  }
  const headerSearchStart = Math.max(0, markerIndex - 16);
  const headerIndexes = lines
    .slice(0, markerIndex)
    .flatMap((line, index) =>
      /^\s*Bash command\s*$/iu.test(line) ? [index] : []
    );
  const absoluteHeaderIndex = headerIndexes.length === 1 &&
      headerIndexes[0] >= headerSearchStart
    ? headerIndexes[0]
    : -1;
  const choiceRows = region.flatMap((line, index) => {
    const match = /^\s*(❯\s*)?([1-4])\.\s*(.+?)\s*$/u.exec(line);
    return match
      ? [{
          index,
          highlighted: Boolean(match[1]),
          number: Number(match[2]),
          label: match[3].trim()
        }]
      : [];
  });
  const highlightedRows = choiceRows.filter((choice) => choice.highlighted);
  const footerIndexes = region
    .map((line, index) =>
      isClaudePermissionFooterLine(line) ? index : -1
    )
    .filter((index) => index >= 0);
  const orderedChoices = [3, 4].includes(choiceRows.length) &&
    choiceRows.every((choice, index) => choice.number === index + 1) &&
    choiceRows.every((choice, index) =>
      index === 0 || choice.index > choiceRows[index - 1].index
    );
  const legacyLabels = orderedChoices && choiceRows.length === 3 &&
    isOneTimeYesChoice(choiceRows[0].label) &&
    isPersistentPermissionChoice(choiceRows[1].label) &&
    /^No(?:\b|,)/iu.test(choiceRows[2].label);
  const autoOnlyLabels = orderedChoices && choiceRows.length === 3 &&
    isOneTimeYesChoice(choiceRows[0].label) &&
    isClaudeAutoModeChoice(choiceRows[1].label) &&
    /^No(?:\b|,)/iu.test(choiceRows[2].label);
  const currentLabels = orderedChoices && choiceRows.length === 4 &&
    isOneTimeYesChoice(choiceRows[0].label) &&
    isPersistentPermissionChoice(choiceRows[1].label) &&
    isClaudeAutoModeChoice(choiceRows[2].label) &&
    /^No(?:\b|,)/iu.test(choiceRows[3].label);
  const exactLabels = legacyLabels || autoOnlyLabels || currentLabels;
  const exactChoiceSpacing = orderedChoices && [
    {
      previousChoice: undefined,
      lines: region.slice(1, choiceRows[0].index)
    },
    ...choiceRows.slice(1).map((choice, index) => ({
      previousChoice: choiceRows[index],
      lines: region.slice(choiceRows[index].index + 1, choice.index)
    }))
  ].every(({ previousChoice, lines: gap }) => gap.every((line) =>
    !line.trim() || Boolean(
      previousChoice &&
      isPersistentPermissionChoice(previousChoice.label) &&
      isClaudePersistentPermissionContinuation(line)
    )
  ));
  const footerIndex = footerIndexes[0] ?? -1;
  const footerAfterChoices = footerIndexes.length === 1 &&
    footerIndex > (choiceRows.at(-1)?.index ?? Number.MAX_SAFE_INTEGER);
  const trailingIsDecorative = footerAfterChoices &&
    region.slice(footerIndex + 1).every((line) => {
      const trimmed = line.trim();
      return !trimmed || /^[─━═╌╍┄┅┈┉\s]+$/u.test(trimmed);
    });
  const markerNearBottom = markerIndex >= Math.max(0, lines.length - 12);
  const detailLines = absoluteHeaderIndex >= 0
    ? lines.slice(absoluteHeaderIndex + 1, markerIndex)
      .map((line) => line.trim())
      .filter(Boolean)
    : [];
  const hasExactDialogShape =
    absoluteHeaderIndex >= 0 &&
    markerNearBottom &&
    orderedChoices &&
    exactLabels &&
    exactChoiceSpacing &&
    footerAfterChoices &&
    trailingIsDecorative &&
    highlightedRows.length === 1 &&
    detailLines.length > 0;

  if (!hasExactDialogShape) {
    return {
      blocked: true,
      approvable: false,
      reason: "the visible Claude Code permission text does not match the supported current Bash dialog exactly; resolve it manually",
      promptKind: "claude_permission"
    };
  }

  const highlighted = highlightedRows[0];
  if (highlighted.number !== 1 || !isOneTimeYesChoice(highlighted.label)) {
    return {
      blocked: true,
      approvable: false,
      reason: isPersistentPermissionChoice(highlighted.label) ||
          isClaudeAutoModeChoice(highlighted.label)
        ? "the highlighted Claude Code choice would persist permission or change approval mode"
        : "the highlighted Claude Code choice is not the one-time Yes option",
      promptKind: "claude_permission"
    };
  }

  const requestDetail = redactString(detailLines.join("\n"))
    .slice(0, CLAUDE_PERMISSION_DETAIL_LENGTH);
  const promptRegionEnd = markerIndex + footerIndex;
  return {
    blocked: true,
    approvable: true,
    promptKind: "claude_permission",
    requestDetail,
    toolName: "Bash",
    promptEvidence: terminalApprovalPromptEvidence(
      autoOnlyLabels || currentLabels
        ? "claude-bash-permission-prompt-v2"
        : "claude-bash-permission-prompt-v1",
      lines.slice(absoluteHeaderIndex, promptRegionEnd + 1).join("\n")
    ),
    action: {
      mode: "keys",
      keys: ["C-m"],
      label: "Yes"
    }
  };
}

function claudeApprovalDetectionLines(screen: string): string[] {
  const lines = normalizeTerminalApprovalPromptRegion(String(screen || ""))
    .split("\n");
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }
  return lines;
}

function claudePermissionVisibleCommandLine(screen: string): string | undefined {
  const lines = claudeDetectionTail(screen);
  const markerIndex = findLastIndex(
    lines,
    (line) => /^\s*Do you want to proceed\?\s*$/iu.test(line)
  );
  if (markerIndex < 0) {
    return undefined;
  }
  const searchStart = Math.max(0, markerIndex - 16);
  const relativeHeaderIndex = findLastIndex(
    lines.slice(searchStart, markerIndex),
    (line) => /^\s*Bash command\s*$/iu.test(line)
  );
  if (relativeHeaderIndex < 0) {
    return undefined;
  }
  return lines
    .slice(searchStart + relativeHeaderIndex + 1, markerIndex)
    .map((line) => line.trim())
    .find((line) => Boolean(line) && !isClaudeAutoModeTipLine(line));
}

function omitClaudePermissionDetails(
  screen: string,
  commandSha256: string | undefined,
  maxLength: number
): string {
  const placeholder = commandSha256
    ? `<verified Bash request omitted; sha256:${commandSha256.slice(0, 12)}>`
    : "<Bash request details omitted; inspect live pane>";
  const lines = normalizedScreenLines(screen);
  const markerIndex = findLastIndex(
    lines,
    (line) => /^\s*Do you want to proceed\?\s*$/iu.test(line)
  );
  let sanitizedScreen: string;
  if (markerIndex < 0) {
    sanitizedScreen = placeholder;
  } else {
    const searchStart = Math.max(0, markerIndex - 16);
    const relativeHeaderIndex = findLastIndex(
      lines.slice(searchStart, markerIndex),
      (line) => /^\s*Bash command\s*$/iu.test(line)
    );
    if (relativeHeaderIndex < 0) {
      sanitizedScreen = placeholder;
    } else {
      const headerIndex = searchStart + relativeHeaderIndex;
      // Start at the live dialog header instead of retaining scrollback. The
      // same raw command may have been echoed earlier and terminal wrapping can
      // split it across physical lines, making exact-string replacement unsafe.
      sanitizedScreen = [
        lines[headerIndex],
        `  ${placeholder}`,
        lines[markerIndex],
        "  <permission options omitted; inspect live pane>"
      ].join("\n");
    }
  }
  const sanitizedLines = normalizedScreenLines(sanitizedScreen);
  const excerpt = sanitizedLines
    .slice(Math.max(0, sanitizedLines.length - CLAUDE_EXCERPT_LINES))
    .join("\n");
  return redactString(excerpt).slice(-Math.max(0, maxLength));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function detectClaudeActivityState(
  screen: string,
  approval = detectClaudeApprovalPrompt(screen)
): { state: "awaiting_approval" | "working" | "idle" | "unknown"; reason: string } {
  if (approval.blocked) {
    return {
      state: "awaiting_approval",
      reason: approval.approvable
        ? "current Claude Code one-time permission prompt is highlighted"
        : "current Claude Code permission dialog requires manual review"
    };
  }

  const lines = claudeDetectionTail(screen);
  const idleIndex = findLastIndex(lines, (line) => isClaudeIdlePromptLine(line));
  const workingIndex = findLastIndex(lines, (line) => isClaudeWorkingLine(line));
  if (idleIndex > workingIndex && idleIndex >= Math.max(0, lines.length - 10)) {
    return {
      state: "idle",
      reason: "current Claude Code input prompt is visible near the end of the terminal tail"
    };
  }
  if (workingIndex >= 0 && workingIndex >= idleIndex) {
    return {
      state: "working",
      reason: "current Claude Code interruptible working marker is visible in the terminal tail"
    };
  }
  return {
    state: "unknown",
    reason: "no current Claude Code idle, working, or permission marker was detected in the terminal tail"
  };
}

export function claudeScreenExcerpt(screen: string, maxLength = 4000): string {
  const lines = normalizedScreenLines(screen);
  const excerpt = lines.slice(Math.max(0, lines.length - CLAUDE_EXCERPT_LINES)).join("\n");
  return redactString(excerpt).slice(-Math.max(0, maxLength));
}

function exactInteractiveAgentRow(
  pid: number,
  rows: readonly ClaudeAgentRow[]
): ClaudeAgentRow | undefined | null {
  const row = rows.find((candidate) =>
    Number.isInteger(candidate.pid) && candidate.pid === pid
  );
  if (!row) {
    return undefined;
  }
  return row.kind && row.kind !== "interactive" ? null : row;
}

function isNonInteractiveFlag(token: string): boolean {
  const flag = token.split("=", 1)[0];
  return NON_INTERACTIVE_FLAGS.has(flag) || /^-p.+/u.test(token);
}

function findClaudeSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      return undefined;
    }
    if (!token.startsWith("-")) {
      return CLAUDE_SUBCOMMANDS.has(token) ? token : undefined;
    }
    const flag = token.split("=", 1)[0];
    if (!token.includes("=") && OPTIONS_WITH_VALUES.has(flag)) {
      index += 1;
      continue;
    }
    if (!token.includes("=") && OPTIONAL_VALUE_OPTIONS.has(flag)) {
      const possibleValue = args[index + 1];
      if (possibleValue && !possibleValue.startsWith("-") && !CLAUDE_SUBCOMMANDS.has(possibleValue)) {
        index += 1;
      }
    }
  }
  return undefined;
}

function optionValue(args: readonly string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === option) {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? nonEmptyString(value) : undefined;
    }
    if (token.startsWith(`${option}=`)) {
      return nonEmptyString(token.slice(option.length + 1));
    }
  }
  return undefined;
}

function shortOptionValue(args: readonly string[], option: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === option) {
      const value = args[index + 1];
      return value && !value.startsWith("-") ? nonEmptyString(value) : undefined;
    }
    if (token.startsWith(option) && token.length > option.length) {
      return nonEmptyString(token.slice(option.length));
    }
  }
  return undefined;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) {
    token += "\\";
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

function claudeDetectionTail(screen: string): string[] {
  const lines = normalizedScreenLines(screen);
  return lines.slice(Math.max(0, lines.length - CLAUDE_SCREEN_TAIL_LINES));
}

function normalizedScreenLines(screen: string): string[] {
  return stripAnsi(String(screen || ""))
    .replace(/\r/g, "")
    .trimEnd()
    .split("\n");
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function isClaudeIdlePromptLine(line: string): boolean {
  return /^\s*❯[\s\u00a0]*$/u.test(line);
}

function isClaudeWorkingLine(line: string): boolean {
  // Codex also renders the words "esc to interrupt". Requiring Claude's spinner prevents
  // a recently reused tmux pane from inheriting a stale Codex working state.
  return /^\s*[✻✽✢✣✤✥✦✧]\s+.+(?:…|\.\.\.|\([^)]*(?:tokens?|\d+s|esc to interrupt)[^)]*\))\s*$/iu.test(line);
}

function isOneTimeYesChoice(label: string): boolean {
  return /^Yes\s*$/iu.test(label);
}

function isPersistentPermissionChoice(label: string): boolean {
  return /(?:don['’]t ask again|always allow|allow (?:this|the).*(?:session|project|directory))/iu.test(label);
}

function isClaudePersistentPermissionContinuation(line: string): boolean {
  return /^\s{4,}(?:\/|~\/|\.\.?\/).+\s+from this project\s*$/iu.test(line);
}

function isClaudeAutoModeChoice(label: string): boolean {
  return /^Yes,\s*and\s+switch\s+to\s+auto\s+mode(?:\s*·\s*auto\s+mode\s+handles\s+these\s+prompts\s+for\s+you)?$/iu
    .test(label);
}

function isClaudeAutoModeTipLine(line: string): boolean {
  return /^Tip:\s*auto mode handles these prompts for you\s*[—-]\s*choose ["“]switch to auto mode["”] below$/iu
    .test(line);
}

function isClaudePermissionFooterLine(line: string): boolean {
  return /^\s*Esc to cancel(?:\s*·\s*Tab to amend(?:\s*·\s*ctrl\+e to explain)?)?\s*$/iu
    .test(line);
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) {
      return index;
    }
  }
  return -1;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

import { createHash } from "node:crypto";
import {
  classifyCodexProcess,
  type CodexProcessKind,
  type ForkContextPackage
} from "./codex-session-provider.js";
import { codexLifecycleBehaviorProfile } from "./codex-lifecycle-compatibility.js";
import { redactString } from "./runtime-log.js";
import type {
  TerminalAgentAdapter,
  TerminalApprovalInspection,
  TerminalApprovalPromptEvidence,
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest,
  TerminalNativeInspectionCapabilities,
  TerminalNativeInspectionEvidenceInventoryEntry,
  TerminalNativeInspectionField,
  TerminalNativeInspectionObservation,
  TerminalNativeInspectionObservationRequest,
  TerminalNativeInspectionOperation,
  TerminalNativeInspectionPlan,
  TerminalScreenInspection,
  TerminalScreenInspectionOptions,
  TerminalThreadLifecycleCapabilities,
  TerminalThreadLifecycleObservation,
  TerminalThreadLifecycleObservationRequest,
  TerminalThreadLifecycleOperation,
  TerminalThreadLifecyclePlan
} from "./terminal-agent-adapter.js";
import {
  normalizeTerminalApprovalPromptRegion,
  terminalApprovalPromptEvidence
} from "./terminal-agent-adapter.js";
import { isExactNativeThreadId } from "./managed-session.js";

export type CodexApprovalPromptDetection =
  | {
      approvable: true;
      key: string;
      keys: readonly string[];
      label: string;
      promptKind: string;
      command?: string;
      promptEvidence: TerminalApprovalPromptEvidence;
    }
  | {
      approvable: false;
      reason: string;
      promptKind?: string;
      command?: string;
    };

export interface CreateCodexTerminalAgentAdapterOptions {
  detectDurableCompletion?: NonNullable<
    TerminalAgentAdapter<CodexProcessKind>["detectDurableCompletion"]
  >;
}

const CODEX_NUMBERED_OPTION = /^[\s›»]*\d+\.\s+/u;
const CODEX_EXACT_APPROVAL_OPTION =
  /^\s*(?:[›»]\s*)?(\d+)\.\s+(.+)\s+\(([^()\r\n]+)\)\s*$/u;
const CODEX_APPROVAL_FOOTER =
  /^\s*Press enter to confirm or esc to cancel(?: or o to open thread)?\s*$/iu;
const CODEX_APPROVAL_DECORATION = /^[─━═╌╍┄┅┈┉\s]+$/u;
const CODEX_PROMPT_ACTIVITY = /^[›»]\s+(?!\d+\.)\S/u;
const CODEX_COMPOSER_LINE = /^[›»](?:\s|$)/u;
const CODEX_TRANSCRIPT_PROMPT_LINE = /^[›»](?:\s|$).*$/gmu;
const CODEX_SKILLS_HINT = /^[›»]\s+Use \/skills\b/u;
const CODEX_FOOTER_LINE =
  /^(?:gpt-[\w.-]+(?:\s|$)|[-\w.]+ default ·)/u;
const CODEX_SESSION_STATUS_PATTERN =
  /\bSession:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/giu;
const CODEX_STATUS_HEADER_PATTERN =
  /\bOpenAI Codex \(v([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^)\s]+)?)\)/u;
const CODEX_STATUS_TOP_BORDER = /^\s*╭[─-]+╮\s*$/u;
const CODEX_STATUS_BOTTOM_BORDER = /^\s*╰[─-]+╯\s*$/u;
const CODEX_STATUS_FIELD = /^\s*│\s*([^:│]{1,64}):\s+(.+?)\s*│\s*$/u;
const CODEX_STATUS_MAX_LINES = 64;
const CODEX_STATUS_MAX_REGION_LENGTH = 8_192;
const CODEX_STATUS_MAX_FIELDS = 24;
const CODEX_STATUS_MAX_FIELD_VALUE_LENGTH = 512;
const CODEX_STATUS_MAX_EXCERPT_LENGTH = 4_000;
const CODEX_STATUS_EVIDENCE_INVENTORY_MAX_ENTRIES = 32;
const CODEX_STATUS_EVIDENCE_MAX_OCCURRENCES = 64;
const CODEX_STATUS_EVIDENCE_SCAN_MAX_LINES = 512;
const CODEX_STATUS_EVIDENCE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
export const CODEX_NATIVE_INSPECTION_COMPOSER_STABLE_MS = 121;
export const CODEX_NATIVE_INSPECTION_COMPOSER_SETTLE_TIMEOUT_MS = 2_000;

export function createCodexTerminalAgentAdapter(
  options: CreateCodexTerminalAgentAdapterOptions = {}
): TerminalAgentAdapter<CodexProcessKind> {
  return {
    agent: "codex",
    displayName: "Codex",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      screenCompletion: true,
      durableCompletion: true,
      cancellation: true
    },
    cancelKeys: ["C-c"],
    classifyProcess(snapshot) {
      const process = classifyCodexProcess(snapshot);
      return process?.kind === "codex_cli" ? process : undefined;
    },
    inspectScreen: inspectCodexScreen,
    probeThreadLifecycle: probeCodexThreadLifecycle,
    planThreadLifecycle: planCodexThreadLifecycle,
    observeThreadLifecycle: observeCodexThreadLifecycle,
    probeNativeInspection: probeCodexNativeInspection,
    planNativeInspection: planCodexNativeInspection,
    observeNativeInspection: observeCodexNativeInspection,
    detectDurableCompletion: options.detectDurableCompletion ?? (async (request) =>
      detectCodexDurableCompletion(request))
  };
}

export function probeCodexNativeInspection(
  agentVersion: string | undefined
): TerminalNativeInspectionCapabilities {
  if (!agentVersion) {
    return {
      status: "unknown",
      statusInspection: false,
      reason: "the running Codex version could not be verified"
    };
  }
  const behaviorProfile = codexLifecycleBehaviorProfile(agentVersion);
  const supported = behaviorProfile !== undefined;
  return {
    status: supported ? "supported" : "unsupported",
    agentVersion,
    behaviorProfile,
    statusInspection: supported,
    reason: supported
      ? "Codex /status native inspection is supported by the verified version"
      : "this exact Codex version has no AKK native inspection behavior profile"
  };
}

export function planCodexNativeInspection(
  operation: TerminalNativeInspectionOperation,
  capabilities: TerminalNativeInspectionCapabilities
): TerminalNativeInspectionPlan {
  const behaviorProfile = codexLifecycleBehaviorProfile(
    capabilities.agentVersion
  );
  if (
    operation.kind !== "status" ||
    capabilities.status !== "supported" ||
    !capabilities.statusInspection ||
    !capabilities.agentVersion ||
    !behaviorProfile ||
    capabilities.behaviorProfile !== behaviorProfile
  ) {
    throw new Error(capabilities.reason);
  }
  return {
    operation,
    behaviorProfile,
    command: "/status",
    effect: "read_only",
    requiresIdle: true,
    composer: {
      kind: "exact",
      minimumStableMs: CODEX_NATIVE_INSPECTION_COMPOSER_STABLE_MS,
      maximumSettleMs: CODEX_NATIVE_INSPECTION_COMPOSER_SETTLE_TIMEOUT_MS
    },
    expectedResult: {
      kind: "native_status",
      presentation: "inline"
    }
  };
}

export function observeCodexNativeInspection(
  request: TerminalNativeInspectionObservationRequest
): TerminalNativeInspectionObservation {
  const screen = request.screen ?? "";
  const screenFingerprint = fingerprintCodexNativeInspection(screen);
  const evidenceInventory = codexStatusEvidenceInventory(screen);
  if (evidenceInventory.status === "ambiguous") {
    return {
      status: "ambiguous",
      screenFingerprint,
      reason: evidenceInventory.reason
    };
  }
  const baselineError = validateCodexStatusEvidenceInventory(
    request.preEnterEvidenceInventory
  );
  if (baselineError) {
    return {
      status: "ambiguous",
      screenFingerprint,
      evidenceInventory: evidenceInventory.entries,
      reason: baselineError
    };
  }
  if (
    request.previousScreenFingerprint !== undefined &&
    request.previousScreenFingerprint === screenFingerprint
  ) {
    return {
      status: "stale",
      screenFingerprint,
      evidenceInventory: evidenceInventory.entries,
      reason: "the Codex screen did not change after the native inspection command"
    };
  }

  const parsed = parseNewestCodexStatusCard(screen);
  if (parsed.status !== "observed") {
    return {
      status: parsed.status,
      screenFingerprint,
      evidenceInventory: evidenceInventory.entries,
      reason: parsed.reason
    };
  }

  const nativeThreadId = parsed.nativeThreadId;
  const observedAgentVersion = parsed.agentVersion;
  const evidenceFingerprint = fingerprintCodexNativeInspection(parsed.region);
  const result = {
    kind: "native_status" as const,
    nativeThreadId,
    agentVersion: observedAgentVersion,
    fields: parsed.fields,
    excerpt: codexNativeStatusExcerpt(observedAgentVersion, parsed.fields)
  };
  const observed = {
    status: "observed" as const,
    nativeThreadId,
    observedAgentVersion,
    evidence: "codex_status_card",
    evidenceFingerprint,
    screenFingerprint,
    evidenceInventory: evidenceInventory.entries,
    result
  };

  if (request.preEnterEvidenceInventory !== undefined) {
    const priorOccurrences = request.preEnterEvidenceInventory.find((entry) =>
      entry.evidenceFingerprint === evidenceFingerprint
    )?.occurrenceCount ?? 0;
    const currentOccurrences = evidenceInventory.entries.find((entry) =>
      entry.evidenceFingerprint === evidenceFingerprint
    )?.occurrenceCount ?? 0;
    if (currentOccurrences <= priorOccurrences) {
      return {
        ...observed,
        status: "stale",
        reason:
          "the newest Codex /status card did not add a fresh exact evidence occurrence after Enter"
      };
    }
  }

  if (!codexLifecycleBehaviorProfile(observedAgentVersion)) {
    return {
      ...observed,
      status: "mismatch",
      reason: `Codex /status reported unsupported version ${observedAgentVersion}`
    };
  }
  if (
    request.expectedAgentVersion !== undefined &&
    observedAgentVersion !== request.expectedAgentVersion
  ) {
    return {
      ...observed,
      status: "mismatch",
      reason: `Codex /status reported version ${observedAgentVersion}, not the verified running version ${request.expectedAgentVersion}`
    };
  }
  if (
    request.expectedNativeThreadId !== undefined &&
    !isExactNativeThreadId(request.expectedNativeThreadId)
  ) {
    return {
      ...observed,
      status: "mismatch",
      reason: "Codex native status inspection requires a complete expected Session UUID"
    };
  }
  if (
    request.expectedNativeThreadId !== undefined &&
    nativeThreadId !== request.expectedNativeThreadId.toLowerCase()
  ) {
    return {
      ...observed,
      status: "mismatch",
      reason: `Codex /status reported ${nativeThreadId}, not the expected native thread ${request.expectedNativeThreadId.toLowerCase()}`
    };
  }
  return observed;
}

export function probeCodexThreadLifecycle(
  agentVersion: string | undefined
): TerminalThreadLifecycleCapabilities {
  if (!agentVersion) {
    return {
      status: "unknown",
      newThread: false,
      resumeExact: false,
      reason: "the running Codex version could not be verified"
    };
  }
  const behaviorProfile = codexLifecycleBehaviorProfile(agentVersion);
  const supported = behaviorProfile !== undefined;
  return {
    status: supported ? "supported" : "unsupported",
    agentVersion,
    behaviorProfile,
    newThread: supported,
    resumeExact: supported,
    candidateDiscovery: supported,
    reason: supported
      ? "Codex /clear, /status identity proof, and exact inline /resume are supported by the verified version"
      : "this exact Codex version has no AKK native-thread lifecycle behavior profile"
  };
}

export function planCodexThreadLifecycle(
  operation: TerminalThreadLifecycleOperation,
  capabilities: TerminalThreadLifecycleCapabilities
): TerminalThreadLifecyclePlan {
  const behaviorProfile = codexLifecycleBehaviorProfile(
    capabilities.agentVersion
  );
  if (
    capabilities.status !== "supported" ||
    !capabilities.agentVersion ||
    !behaviorProfile ||
    capabilities.behaviorProfile !== behaviorProfile
  ) {
    throw new Error(capabilities.reason);
  }
  if (operation.kind === "new_thread") {
    if (!capabilities.newThread) {
      throw new Error("this Codex version does not support verified new-thread control");
    }
    return {
      operation,
      behaviorProfile,
      steps: [
        {
          kind: "identity_probe_before",
          command: "/status",
          effect: "read_only",
          requiresIdle: true
        },
        {
          kind: "transition",
          command: "/clear",
          effect: "thread_transition",
          requiresIdle: true
        },
        {
          kind: "identity_probe_after",
          command: "/status",
          effect: "read_only",
          requiresIdle: true
        }
      ],
      command: "/clear",
      identityProbeCommand: "/status",
      expectedResult: { kind: "different_native_thread" }
    };
  }
  if (!capabilities.resumeExact) {
    throw new Error("this Codex version does not support verified exact resume control");
  }
  if (!isExactNativeThreadId(operation.nativeThreadId)) {
    throw new Error("Codex resume requires a complete native thread UUID");
  }
  return {
    operation,
    behaviorProfile,
    steps: [
      {
        kind: "transition",
        command: `/resume ${operation.nativeThreadId}`,
        effect: "thread_transition",
        requiresIdle: true
      },
      {
        kind: "identity_probe_after",
        command: "/status",
        effect: "read_only",
        requiresIdle: true
      }
    ],
    command: `/resume ${operation.nativeThreadId}`,
    identityProbeCommand: "/status",
    expectedResult: {
      kind: "exact_native_thread",
      nativeThreadId: operation.nativeThreadId
    }
  };
}

export function observeCodexThreadLifecycle(
  request: TerminalThreadLifecycleObservationRequest
): TerminalThreadLifecycleObservation;
/** @deprecated Pass a typed observation request. */
export function observeCodexThreadLifecycle(
  screen: string,
  operation: TerminalThreadLifecycleOperation
): TerminalThreadLifecycleObservation;
export function observeCodexThreadLifecycle(
  requestOrScreen: TerminalThreadLifecycleObservationRequest | string,
  legacyOperation?: TerminalThreadLifecycleOperation
): TerminalThreadLifecycleObservation {
  const request = typeof requestOrScreen === "string"
    ? {
        screen: requestOrScreen,
        operation: legacyOperation ?? { kind: "new_thread" as const },
        phase: "after" as const
      }
    : requestOrScreen;
  const screen = request.screen ?? "";
  const statusRegion = newestCodexStatusRegion(screen);
  if (statusRegion === undefined) {
    return {
      status: "missing",
      reason: "Codex /status marker is not visible in the observed screen region"
    };
  }
  const matches = [...statusRegion.matchAll(CODEX_SESSION_STATUS_PATTERN)];
  const ids = [...new Set(matches.map((match) => match[1].toLowerCase()))];
  if (ids.length === 0) {
    return {
      status: "missing",
      reason: "Codex /status did not expose a complete Session UUID"
    };
  }
  if (ids.length !== 1) {
    return {
      status: "ambiguous",
      reason: "the newest Codex /status region contains multiple Session UUIDs"
    };
  }
  const nativeThreadId = ids[0];
  const observed: TerminalThreadLifecycleObservation = {
    status: "observed",
    nativeThreadId,
    evidence: "codex_status_card"
  };
  if (request.phase === "before") {
    return observed;
  }
  if (request.operation.kind === "new_thread") {
    if (!isExactNativeThreadId(request.beforeNativeThreadId)) {
      return {
        ...observed,
        status: "mismatch",
        reason: "a verified before-thread UUID is required for Codex /clear"
      };
    }
    return nativeThreadId === request.beforeNativeThreadId.toLowerCase()
      ? {
          ...observed,
          status: "mismatch",
          reason: "Codex /clear did not change the Session UUID"
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
      reason: "Codex resume postcondition requires an exact target UUID"
    };
  }
  return nativeThreadId === expected
    ? { ...observed, status: "verified" }
    : {
        ...observed,
        status: "mismatch",
        reason: `Codex resumed ${nativeThreadId}, not the requested native thread ${expected}`
    };
}

type ParsedCodexStatusCard =
  | {
      status: "observed";
      region: string;
      nativeThreadId: string;
      agentVersion: string;
      fields: readonly TerminalNativeInspectionField[];
    }
  | {
      status: "missing" | "ambiguous";
      reason: string;
    };

function parseNewestCodexStatusCard(screen: string): ParsedCodexStatusCard {
  const lines = screen.split(/\r?\n/u);
  let commandIndex = -1;
  let command: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = codexNativeCommandLine(lines[index]);
    if (candidate !== undefined) {
      commandIndex = index;
      command = candidate;
      break;
    }
  }
  if (commandIndex < 0 || command !== "/status") {
    return {
      status: "missing",
      reason: commandIndex < 0
        ? "Codex /status command is not visible in the observed screen"
        : "the newest Codex native command is not /status"
    };
  }

  return parseCodexStatusCardAfterCommand(lines, commandIndex);
}

function parseCodexStatusCardAfterCommand(
  lines: readonly string[],
  commandIndex: number
): ParsedCodexStatusCard {
  let topBorderIndex = commandIndex + 1;
  while (topBorderIndex < lines.length && !lines[topBorderIndex].trim()) {
    topBorderIndex += 1;
  }
  if (
    topBorderIndex >= lines.length ||
    !CODEX_STATUS_TOP_BORDER.test(lines[topBorderIndex])
  ) {
    return {
      status: "missing",
      reason: "the newest Codex /status command has no complete status-card opening border"
    };
  }

  const lineLimit = Math.min(
    lines.length,
    topBorderIndex + CODEX_STATUS_MAX_LINES
  );
  let bottomBorderIndex = -1;
  for (let index = topBorderIndex + 1; index < lineLimit; index += 1) {
    if (CODEX_STATUS_BOTTOM_BORDER.test(lines[index])) {
      bottomBorderIndex = index;
      break;
    }
  }
  if (bottomBorderIndex < 0) {
    return {
      status: "missing",
      reason: "the newest Codex /status card is incomplete or exceeds the bounded parser window"
    };
  }

  const region = lines.slice(topBorderIndex, bottomBorderIndex + 1).join("\n");
  if (region.length > CODEX_STATUS_MAX_REGION_LENGTH) {
    return {
      status: "ambiguous",
      reason: "the newest Codex /status card exceeds the bounded inspection size"
    };
  }

  const versionMatches = [...region.matchAll(new RegExp(CODEX_STATUS_HEADER_PATTERN, "gu"))];
  if (versionMatches.length === 0) {
    return {
      status: "missing",
      reason: "the newest Codex /status card has no exact version header"
    };
  }
  if (versionMatches.length !== 1) {
    return {
      status: "ambiguous",
      reason: "the newest Codex /status card contains multiple version headers"
    };
  }

  const sessionMatches = [...region.matchAll(CODEX_SESSION_STATUS_PATTERN)];
  if (sessionMatches.length === 0) {
    return {
      status: "missing",
      reason: "the newest Codex /status card did not expose a complete Session UUID"
    };
  }
  if (sessionMatches.length !== 1) {
    return {
      status: "ambiguous",
      reason: "the newest Codex /status card contains multiple Session UUID fields"
    };
  }

  const fields: TerminalNativeInspectionField[] = [];
  for (const line of lines.slice(topBorderIndex + 1, bottomBorderIndex)) {
    const match = CODEX_STATUS_FIELD.exec(line);
    if (!match) {
      continue;
    }
    if (fields.length >= CODEX_STATUS_MAX_FIELDS) {
      return {
        status: "ambiguous",
        reason: "the newest Codex /status card contains too many structured fields"
      };
    }
    const name = redactCodexNativeStatusText(match[1].trim()).slice(0, 64);
    const value = /^account$/iu.test(name)
      ? "[REDACTED]"
      : redactCodexNativeStatusText(match[2].trim())
        .slice(0, CODEX_STATUS_MAX_FIELD_VALUE_LENGTH);
    fields.push({ name, value });
  }

  return {
    status: "observed",
    region,
    nativeThreadId: sessionMatches[0][1].toLowerCase(),
    agentVersion: versionMatches[0][1],
    fields
  };
}

type CodexStatusEvidenceInventory =
  | {
      status: "ok";
      entries: readonly TerminalNativeInspectionEvidenceInventoryEntry[];
    }
  | {
      status: "ambiguous";
      reason: string;
    };

function codexStatusEvidenceInventory(
  screen: string
): CodexStatusEvidenceInventory {
  const allLines = screen.split(/\r?\n/u);
  const lines = allLines.slice(-CODEX_STATUS_EVIDENCE_SCAN_MAX_LINES);
  const counts = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (codexNativeCommandLine(lines[index]) !== "/status") {
      continue;
    }
    const parsed = parseCodexStatusCardAfterCommand(lines, index);
    if (parsed.status !== "observed") {
      continue;
    }
    const evidenceFingerprint = fingerprintCodexNativeInspection(parsed.region);
    const occurrenceCount = (counts.get(evidenceFingerprint) ?? 0) + 1;
    if (occurrenceCount > CODEX_STATUS_EVIDENCE_MAX_OCCURRENCES) {
      return {
        status: "ambiguous",
        reason:
          "the Codex status evidence inventory exceeds its bounded occurrence count"
      };
    }
    counts.set(evidenceFingerprint, occurrenceCount);
    if (counts.size > CODEX_STATUS_EVIDENCE_INVENTORY_MAX_ENTRIES) {
      return {
        status: "ambiguous",
        reason:
          "the Codex status evidence inventory exceeds its bounded distinct-card count"
      };
    }
  }
  return {
    status: "ok",
    entries: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([evidenceFingerprint, occurrenceCount]) => ({
        evidenceFingerprint,
        occurrenceCount
      }))
  };
}

function validateCodexStatusEvidenceInventory(
  inventory:
    readonly TerminalNativeInspectionEvidenceInventoryEntry[] | undefined
): string | undefined {
  if (inventory === undefined) {
    return undefined;
  }
  if (!Array.isArray(inventory)) {
    return "the pre-Enter Codex status evidence inventory must be an array";
  }
  if (inventory.length > CODEX_STATUS_EVIDENCE_INVENTORY_MAX_ENTRIES) {
    return "the pre-Enter Codex status evidence inventory has too many entries";
  }
  const fingerprints = new Set<string>();
  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "the pre-Enter Codex status evidence inventory is malformed or ambiguous";
    }
    if (
      typeof entry.evidenceFingerprint !== "string" ||
      !CODEX_STATUS_EVIDENCE_FINGERPRINT.test(entry.evidenceFingerprint) ||
      typeof entry.occurrenceCount !== "number" ||
      !Number.isSafeInteger(entry.occurrenceCount) ||
      entry.occurrenceCount <= 0 ||
      entry.occurrenceCount > CODEX_STATUS_EVIDENCE_MAX_OCCURRENCES ||
      fingerprints.has(entry.evidenceFingerprint)
    ) {
      return "the pre-Enter Codex status evidence inventory is malformed or ambiguous";
    }
    fingerprints.add(entry.evidenceFingerprint);
  }
  return undefined;
}

function codexNativeCommandLine(line: string): string | undefined {
  const normalized = line
    .trim()
    .replace(/^[›»]\s*/u, "")
    .trim();
  return /^\/[a-z][a-z0-9_-]*(?:\s|$)/iu.test(normalized)
    ? normalized
    : undefined;
}

function fingerprintCodexNativeInspection(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redactCodexNativeStatusText(value: string): string {
  return redactString(value).replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    "[REDACTED EMAIL]"
  );
}

function codexNativeStatusExcerpt(
  agentVersion: string,
  fields: readonly TerminalNativeInspectionField[]
): string {
  return [
    `OpenAI Codex v${agentVersion}`,
    ...fields.map((field) => `${field.name}: ${field.value}`)
  ].join("\n").slice(0, CODEX_STATUS_MAX_EXCERPT_LENGTH);
}

function newestCodexStatusRegion(screen: string): string | undefined {
  const lines = screen.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const command = codexLifecycleCommandLine(lines[index]);
    if (command !== undefined) {
      return command === "/status"
        ? lines.slice(index).join("\n")
        : undefined;
    }
  }
  return undefined;
}

function codexLifecycleCommandLine(line: string): string | undefined {
  const normalized = line
    .trim()
    .replace(/^[›»│]\s*/u, "")
    .replace(/\s*│$/u, "")
    .trim();
  return /^\/(?:status|clear|resume)(?:\s|$)/u.test(normalized)
    ? normalized
    : undefined;
}


export const codexTerminalAgentAdapter = createCodexTerminalAgentAdapter();

export function inspectCodexScreen(options: TerminalScreenInspectionOptions): TerminalScreenInspection {
  const detectedApproval = detectCodexApprovalPrompt(options.screen);
  const blocked = isCodexApprovalPromptVisible(options.screen);
  const approval: TerminalApprovalInspection = detectedApproval.approvable
    ? {
        blocked: true,
        approvable: true,
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command,
        promptEvidence: detectedApproval.promptEvidence,
        action: {
          keys: detectedApproval.keys,
          label: detectedApproval.label
        }
      }
    : {
        blocked,
        approvable: false,
        reason: detectedApproval.reason,
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command
      };
  const activity = detectCodexActivityState(options.screen, detectedApproval);
  const screenExcerpt = codexScreenExcerpt(options.screen, options.maxExcerptLength ?? 4000);
  const completion = activity.state === "idle"
    ? detectCodexScreenCompletion({
        screen: screenExcerpt,
        requestText: options.requestText,
        screenChangedSinceSend: options.screenChangedSinceSend
      })
    : undefined;

  return {
    activity,
    approval,
    screenExcerpt,
    completion
  };
}

export function detectCodexApprovalPrompt(screen: string): CodexApprovalPromptDetection {
  const prompt = codexApprovalPromptRegion(screen);
  if (!prompt.visible) {
    return {
      approvable: false,
      reason: prompt.reason
    };
  }
  if (!("region" in prompt)) {
    return {
      approvable: false,
      reason: prompt.reason
    };
  }

  const primary = prompt.region.split("\n")
    .map(parseCodexApprovalOption)
    .find((option) => option?.number === 1);
  if (!primary) {
    return {
      approvable: false,
      reason: "no primary approve option with a shortcut was detected",
      ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
    };
  }
  const key = primary.shortcut;
  if (key !== "y") {
    return {
      approvable: false,
      reason: `primary approval shortcut is ${key}, not y`,
      ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
    };
  }
  return {
    approvable: true,
    key,
    keys: [key],
    label: primary.label,
    promptEvidence: terminalApprovalPromptEvidence(
      "codex-approval-prompt-v1",
      prompt.region
    ),
    ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
  };
}

export function isCodexApprovalPromptVisible(screen: string): boolean {
  return codexApprovalPromptRegion(screen).visible;
}

export function detectCodexActivityState(
  screen: string,
  approval = detectCodexApprovalPrompt(screen)
): { state: "awaiting_approval" | "working" | "idle" | "unknown"; reason: string } {
  if (approval.approvable || isCodexApprovalPromptVisible(screen)) {
    return {
      state: "awaiting_approval",
      reason: "current Codex approval prompt is visible"
    };
  }

  const tailLines = screen.trimEnd().split(/\r?\n/).slice(-30);
  const workingLine = tailLines.find((line) => isCodexWorkingLine(line));
  if (workingLine) {
    return {
      state: "working",
      reason: `Codex working marker detected: ${redactString(workingLine.trim())}`
    };
  }

  const idleLine = codexIdlePromptLine(tailLines.slice(-6));
  if (idleLine) {
    return {
      state: "idle",
      reason: "Codex input prompt detected"
    };
  }

  return {
    state: "unknown",
    reason: "no current Codex working, idle, or approval marker was detected in the terminal screen"
  };
}

export function codexScreenExcerpt(screen: string, maxLength = 4000): string {
  const lines = screen.trimEnd().split(/\r?\n/);
  const excerpt = lines.slice(Math.max(0, lines.length - 80)).join("\n");
  return redactString(excerpt).slice(-maxLength);
}

export function detectCodexScreenCompletion({
  screen,
  requestText,
  screenChangedSinceSend
}: {
  screen: string;
  requestText?: string;
  screenChangedSinceSend?: boolean;
}): TerminalCompletionEvidence | undefined {
  const request = requestText?.trim() ?? "";
  const promptEnd = request ? whitespaceInsensitiveMatchEnd(screen, request) : undefined;
  const afterPrompt = promptEnd === undefined ? undefined : screen.slice(promptEnd);
  const completionBoundary = afterPrompt === undefined
    ? undefined
    : codexCompletionBoundary(afterPrompt);
  const completionText = afterPrompt === undefined
    ? screenChangedSinceSend
      ? latestCompletedCodexSegment(screen)
      : undefined
    : completionBoundary === undefined
      ? afterPrompt
      : afterPrompt.slice(0, completionBoundary);
  if (completionText === undefined) {
    return undefined;
  }
  const cleaned = cleanCodexTerminalScreenText(completionText);
  const hasCompletionEvidence = promptEnd === undefined || completionBoundary !== undefined || /[•└]/u.test(cleaned ?? "");
  if (!cleaned || cleaned.length < 40 || !hasCompletionEvidence) {
    return undefined;
  }

  return {
    source: "screen",
    text: truncateText(redactString(cleaned), 4000),
    confidence: "screen_only"
  };
}

export function detectCodexDurableCompletion(
  request: TerminalDurableCompletionRequest
): TerminalCompletionEvidence | undefined {
  const context = asForkContextPackage(request.context);
  const threshold = validTimestampMs(request.startedAt);
  const expectedRequestHash = request.requestHash ?? requestFingerprint(request.requestText);
  if (!context || threshold === undefined || !expectedRequestHash) {
    return undefined;
  }

  const turn = [...context.turns]
    .reverse()
    .find((candidate) => {
      const userTimestamp = validTimestampMs(candidate.userTimestamp);
      const completedAt = validTimestampMs(candidate.completedAt);
      return candidate.userTextHash === expectedRequestHash &&
        userTimestamp !== undefined &&
        completedAt !== undefined &&
        userTimestamp >= threshold &&
        completedAt >= userTimestamp &&
        Boolean(candidate.lastAssistantMessage);
    });
  if (!turn?.lastAssistantMessage) {
    return undefined;
  }
  return {
    source: "durable",
    text: turn.lastAssistantMessage,
    timestamp: turn.completedAt,
    id: turn.turnId,
    confidence: "high",
    metadata: {
      match: "rollout_task_complete",
      userTimestamp: turn.userTimestamp,
      session: context.source
    }
  };
}

function codexApprovalPromptRegion(screen: string):
  | { visible: true; region: string; marker: string }
  | { visible: true; reason: string; marker: string }
  | { visible: false; reason: string } {
  const approvalMarkers = [
    "Would you like to run the following command?",
    "Would you like to make the following edits?",
    "Would you like to grant these permissions?"
  ];
  const lines = normalizeTerminalApprovalPromptRegion(screen).split("\n");
  const markerRows = lines.flatMap((line, index) => {
    const trimmed = line.trim();
    const marker = approvalMarkers.find((candidate) => trimmed === candidate) ??
      (/^.+ needs your approval\.$/u.test(trimmed) ? trimmed : undefined);
    return marker ? [{ index, marker }] : [];
  });
  if (markerRows.length > 1) {
    return {
      visible: true,
      marker: markerRows.at(-1)?.marker ?? "",
      reason:
        "multiple Codex approval markers are ambiguous; resolve the dialog manually"
    };
  }
  const currentMarker = markerRows[0];
  const markerIndex = currentMarker?.index ?? -1;
  const matchedMarker = currentMarker?.marker ?? "";

  if (markerIndex < 0) {
    return {
      visible: false,
      reason: "no Codex approval prompt was detected in the terminal screen"
    };
  }

  const candidateLines = lines.slice(markerIndex);
  const staleLine = candidateLines.slice(1).find((line) => isPostApprovalActivityLine(line));
  if (staleLine) {
    return {
      visible: false,
      reason: "Codex approval prompt appears stale after later terminal activity"
    };
  }
  const parsed = parseCodexApprovalMenu(candidateLines);
  if (!parsed.ok) {
    return {
      visible: true,
      marker: matchedMarker,
      reason: parsed.reason
    };
  }

  return {
    visible: true,
    region: candidateLines.slice(0, parsed.evidenceEndIndex + 1).join("\n"),
    marker: matchedMarker
  };
}

interface CodexApprovalOptionRow {
  number: number;
  label: string;
  shortcut: string;
}

function parseCodexApprovalOption(line: string): CodexApprovalOptionRow | undefined {
  const match = CODEX_EXACT_APPROVAL_OPTION.exec(line);
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  const label = match[2].trim();
  const shortcut = match[3].trim().toLowerCase();
  return Number.isSafeInteger(number) && number > 0 && label && shortcut
    ? { number, label, shortcut }
    : undefined;
}

function parseCodexApprovalMenu(
  candidateLines: readonly string[]
):
  | { ok: true; evidenceEndIndex: number }
  | { ok: false; reason: string } {
  const primaryIndexes = candidateLines.flatMap((line, index) => {
    const option = parseCodexApprovalOption(line);
    return option?.number === 1 &&
        /^Yes(?:\b|,)/iu.test(option.label) &&
        option.shortcut === "y"
      ? [index]
      : [];
  });
  if (primaryIndexes.length !== 1) {
    return {
      ok: false,
      reason: primaryIndexes.length === 0
        ? "no exact primary Codex approve option was detected"
        : "multiple primary Codex approve options are ambiguous"
    };
  }

  const primaryIndex = primaryIndexes[0];
  const options: Array<CodexApprovalOptionRow & { index: number }> = [];
  for (let index = primaryIndex; index < candidateLines.length; index += 1) {
    const option = parseCodexApprovalOption(candidateLines[index]);
    if (!option) {
      break;
    }
    if (option.number !== options.length + 1) {
      return {
        ok: false,
        reason: "Codex approval choices are duplicated or out of order"
      };
    }
    options.push({ ...option, index });
  }
  const finalOption = options.at(-1);
  if (
    options.length < 2 ||
    !finalOption ||
    !/^(?:No|Cancel)(?:\b|,)/iu.test(finalOption.label) ||
    finalOption.shortcut === "y"
  ) {
    return {
      ok: false,
      reason: "Codex approval prompt has no exact final reject or cancel choice"
    };
  }

  let evidenceEndIndex = finalOption.index;
  let trailingIndex = finalOption.index + 1;
  while (
    trailingIndex < candidateLines.length &&
    !candidateLines[trailingIndex].trim()
  ) {
    trailingIndex += 1;
  }
  if (
    trailingIndex < candidateLines.length &&
    CODEX_APPROVAL_FOOTER.test(candidateLines[trailingIndex])
  ) {
    evidenceEndIndex = trailingIndex;
    trailingIndex += 1;
  }
  if (
    candidateLines.slice(trailingIndex).some((line) =>
      line.trim() && !CODEX_APPROVAL_DECORATION.test(line)
    )
  ) {
    return {
      ok: false,
      reason:
        "text after the bounded Codex approval prompt is not safely attributable to the current dialog"
    };
  }
  return { ok: true, evidenceEndIndex };
}

function approvalCandidateFromPrompt(marker: string, region: string): { promptKind: string; command?: string } {
  const promptKind = marker === "Would you like to run the following command?"
    ? "run_command"
    : marker === "Would you like to make the following edits?"
      ? "file_edit"
      : marker === "Would you like to grant these permissions?"
        ? "grant_permissions"
        : "unknown";
  return {
    promptKind,
    command: promptKind === "run_command" ? commandFromApprovalRegion(region) : undefined
  };
}

function commandFromApprovalRegion(region: string): string | undefined {
  const lines = region.split(/\r?\n/);
  const commandStart = lines.findIndex((line) => /^\s*\$\s+/u.test(line));
  if (commandStart < 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (let index = commandStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      index > commandStart &&
      (
        !line.trim() ||
        CODEX_NUMBERED_OPTION.test(line) ||
        /Press enter to confirm/u.test(line)
      )
    ) {
      break;
    }
    parts.push(index === commandStart ? line.replace(/^\s*\$\s+/u, "").trim() : line.trim());
  }
  const command = parts.filter(Boolean).join(" ").trim();
  return command ? redactString(command) : undefined;
}

function isPostApprovalActivityLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^✔\s+You approved\b/u.test(trimmed)) {
    return true;
  }
  if (CODEX_PROMPT_ACTIVITY.test(trimmed)) {
    return true;
  }
  if (/^•\s+(Working|Ran|Explored|Edited|Read|Called|Searching|Planning|Updated|Added|Deleted|Modified|Running|Thinking)\b/u.test(trimmed)) {
    return true;
  }
  return /^─\s*Worked for\b/u.test(trimmed);
}

function isCodexWorkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^•\s+Working\b/u.test(trimmed) && (/\besc to interrupt\b/u.test(trimmed) || trimmed === "• Working")) {
    return true;
  }
  if (/^•\s+Waiting for background terminals?\b(?:\s*·|$)/u.test(trimmed)) {
    return true;
  }
  return /^\d+\s+background terminals? running\b/u.test(trimmed) && /\/(?:ps|stop)\b/u.test(trimmed);
}

function codexIdlePromptLine(lines: readonly string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trimEnd();
    if (
      !CODEX_COMPOSER_LINE.test(line) ||
      CODEX_NUMBERED_OPTION.test(line)
    ) {
      continue;
    }

    const composerText = line.slice(1).trim();
    if (!composerText) {
      return line;
    }

    const trailingContent = lines
      .slice(index + 1)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    if (
      trailingContent.length > 0 &&
      trailingContent.every((candidate) => CODEX_FOOTER_LINE.test(candidate))
    ) {
      return line;
    }
  }
  return undefined;
}

function whitespaceInsensitiveMatchEnd(text: string, expected: string): number | undefined {
  const normalizedExpected = expected.replace(/\s/gu, "");
  if (!normalizedExpected) {
    return undefined;
  }

  let normalizedText = "";
  const sourceEnds: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) {
      normalizedText += character;
      for (let codeUnit = 0; codeUnit < character.length; codeUnit += 1) {
        sourceEnds.push(index + character.length);
      }
    }
    index += character.length;
  }

  const matchIndex = normalizedText.lastIndexOf(normalizedExpected);
  if (matchIndex < 0) {
    return undefined;
  }
  return sourceEnds[matchIndex + normalizedExpected.length - 1];
}

function latestCompletedCodexSegment(text: string): string | undefined {
  const matches = [...text.matchAll(/^[ \t]*[─━-]+\s+Worked for\b.*$/gmu)];
  const completion = matches.at(-1);
  if (completion?.index === undefined) {
    return undefined;
  }

  const previousCompletion = matches.at(-2);
  let start = previousCompletion?.index === undefined
    ? 0
    : previousCompletion.index + previousCompletion[0].length;
  const beforeCompletion = text.slice(0, completion.index);
  const turnPrompt = [...beforeCompletion.matchAll(CODEX_TRANSCRIPT_PROMPT_LINE)]
    .find((candidate) => candidate.index !== undefined && candidate.index >= start);
  if (turnPrompt?.index !== undefined) {
    start = turnPrompt.index + turnPrompt[0].length;
  }
  return text.slice(start, completion.index);
}

function codexCompletionBoundary(text: string): number | undefined {
  const matches = [...text.matchAll(/^[ \t]*[─━-]+\s+Worked for\b.*$/gmu)];
  return matches.at(-1)?.index;
}

function cleanCodexTerminalScreenText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed &&
        !CODEX_SKILLS_HINT.test(trimmed) &&
        !/^gpt-[\w.-]+/u.test(trimmed) &&
        !/^[-\w.]+ default ·/u.test(trimmed);
    });
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

function asForkContextPackage(value: unknown): ForkContextPackage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const context = value as Partial<ForkContextPackage>;
  return context.source && Array.isArray(context.turns)
    ? context as ForkContextPackage
    : undefined;
}

function validTimestampMs(value: string | undefined): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requestFingerprint(value: string | undefined): string | undefined {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}

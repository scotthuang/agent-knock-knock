import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  claudeLifecycleBehaviorProfile,
  claudeLifecycleSourceVersionSupported,
  DEFAULT_CLAUDE_LIFECYCLE_VERSION,
  supportedClaudeLifecycleVersions
} from "./claude-lifecycle-compatibility.js";
import { redactString } from "./runtime-log.js";
import { isRecord } from "./value-guards.js";
import type {
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest,
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken,
  TerminalThreadLifecycleCandidateValidation,
  TerminalThreadFileToken
} from "./terminal-agent-adapter.js";
import {
  validateTerminalSubmissionAcceptanceEvidence,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";

const CLAUDE_TRANSCRIPT_ANCHOR_VERSION = 1;
const CLAUDE_TRANSCRIPT_MAX_TURN_BYTES = 64 * 1024 * 1024;
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MINIMUM_CLAUDE_TRANSCRIPT_VERSION = [2, 1, 198] as const;
const CLAUDE_TRANSCRIPT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const CLAUDE_HISTORICAL_METADATA_MAX_BYTES = 1024 * 1024;

export interface ClaudeTranscriptAnchor {
  schema_version: 1;
  session_id: string;
  cwd: string;
  pid: number;
  agent_started_at_ms: number;
  captured_at: string;
  relative_path: string;
  offset_bytes: number;
  file_existed: boolean;
  device?: string;
  inode?: string;
}

export interface CaptureClaudeTranscriptAnchorOptions {
  sessionId?: string;
  cwd?: string;
  pid?: number;
  claudeHome?: string;
  agentRows: readonly ClaudeAgentRow[];
  now?: Date;
}

export interface DetectClaudeTranscriptCompletionOptions {
  claudeHome?: string;
  agentRows: readonly ClaudeAgentRow[];
  maxTurnBytes?: number;
}

export interface ObserveClaudeDeadProcessCompletionOptions
  extends DetectClaudeTranscriptCompletionOptions {
  acceptanceEvidence: unknown;
}

export type ClaudeDeadProcessCompletionObservation =
  | {
      status: "present";
      completion: TerminalCompletionEvidence;
    }
  | { status: "absent" }
  | {
      status: "unverifiable";
      reason: string;
    };

export interface ClaudeHistoricalSessionSummary {
  id: string;
  cwd: string;
  transcriptPath: string;
  updatedAtMs: number;
  claudeVersion: string;
  rootInteractive: true;
  fileToken: TerminalThreadFileToken;
  metadataFingerprint: string;
  candidateToken: TerminalThreadLifecycleCandidateToken;
}

/**
 * Process-local evidence for one pending, foreground Claude Bash permission.
 * `command` is intentionally raw so the caller can apply the exact command
 * policy, but callers must not persist this object or add it to callbacks.
 */
export interface ClaudeTranscriptPendingApprovalEvidence {
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

/**
 * Durable, privacy-preserving proof that the exact managed request became a
 * native root Claude turn. The request text and transcript path are
 * intentionally omitted so this evidence is safe to persist in a receipt.
 */
export type ClaudeTranscriptAcceptanceEvidence =
  TerminalSubmissionAcceptanceEvidence & { source: "claude_transcript" };

interface TranscriptRecord {
  [key: string]: unknown;
}

interface OpenTranscript {
  fd: number;
  stat: fs.Stats;
  relativePath: string;
}

interface ClaudeTranscriptTurnSnapshot {
  anchor: ClaudeTranscriptAnchor;
  sessionId: string;
  cwd: string;
  expectedRequestHash: string;
  expectedPromptText: string;
  records: readonly TranscriptRecord[];
  transcriptFileId: string;
  observedEndOffsetBytes: number;
}

export function defaultClaudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(os.homedir(), ".claude");
}

/** List exact, root-interactive Claude sessions from owner-private transcripts. */
export function listClaudeHistoricalSessions(options: {
  cwd: string;
  claudeHome?: string;
  agentVersion?: string;
}): ClaudeHistoricalSessionSummary[] {
  if (!options.cwd || !path.isAbsolute(options.cwd)) {
    throw new Error("Claude lifecycle candidate discovery requires an absolute cwd");
  }
  const cwd = path.resolve(options.cwd);
  const claudeHome = path.resolve(options.claudeHome ?? defaultClaudeHome());
  const agentVersion = options.agentVersion ?? DEFAULT_CLAUDE_LIFECYCLE_VERSION;
  if (!claudeLifecycleBehaviorProfile(agentVersion)) {
    throw new Error(
      "Claude lifecycle candidates require one of the supported exact versions: " +
      supportedClaudeLifecycleVersions().join(", ")
    );
  }
  const projectsRoot = projectsRootPath(claudeHome);
  if (!isRealDirectory(projectsRoot)) {
    return [];
  }
  const projectRelative = path.dirname(
    expectedTranscriptRelativePath("00000000-0000-0000-0000-000000000000", cwd)
  );
  const projectDirectory = path.join(projectsRoot, projectRelative);
  if (!isRealDirectory(projectDirectory)) {
    return [];
  }
  return fs.readdirSync(projectDirectory, { withFileTypes: true })
    .flatMap((entry): ClaudeHistoricalSessionSummary[] => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        return [];
      }
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(
        entry.name
      );
      if (!match) {
        return [];
      }
      try {
        const summary = inspectClaudeHistoricalSession({
          projectsRoot,
          cwd,
          sessionId: match[1].toLowerCase(),
          agentVersion
        });
        return summary ? [summary] : [];
      } catch {
        // Unsafe, malformed, or unstable transcript files are not candidates.
        return [];
      }
    })
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function listClaudeThreadLifecycleCandidates(options: {
  cwd: string;
  claudeHome?: string;
  agentVersion: string;
}): TerminalThreadLifecycleCandidate[] {
  return listClaudeHistoricalSessions(options).map((session) => ({
    agent: "claude",
    nativeThreadId: session.id,
    cwd: session.cwd,
    source: "claude_transcript",
    rootInteractive: true,
    fileToken: session.fileToken,
    agentVersion: options.agentVersion,
    sourceAgentVersion: session.claudeVersion,
    updatedAtMs: session.updatedAtMs,
    metadataFingerprint: session.metadataFingerprint,
    candidateToken: session.candidateToken
  }));
}

export function createClaudeThreadLifecycleCandidateProvider(options: {
  claudeHome?: string;
} = {}): TerminalThreadLifecycleCandidateProvider {
  return {
    async listThreadLifecycleCandidates(request) {
      return listClaudeThreadLifecycleCandidates({
        cwd: request.cwd,
        agentVersion: request.agentVersion,
        claudeHome: options.claudeHome
      });
    },
    async revalidateThreadLifecycleCandidate(candidate, request) {
      return revalidateClaudeThreadLifecycleCandidate(candidate, {
        ...request,
        claudeHome: options.claudeHome
      });
    }
  };
}

export function revalidateClaudeThreadLifecycleCandidate(
  candidate: TerminalThreadLifecycleCandidate | TerminalThreadLifecycleCandidateToken,
  options: TerminalThreadLifecycleCandidateRequest & { claudeHome?: string }
): TerminalThreadLifecycleCandidateValidation {
  try {
    const token = "candidateToken" in candidate
      ? candidate.candidateToken
      : candidate;
    if (
      token.schema !== "agent-knock-knock/thread-candidate-token" ||
      ![1, 2].includes(token.version) ||
      token.agent !== "claude" ||
      token.source !== "claude_transcript" ||
      token.agentVersion !== options.agentVersion ||
      !claudeLifecycleSourceVersionSupported(
        options.agentVersion,
        claudeCandidateSourceAgentVersion(token)
      ) ||
      !path.isAbsolute(options.cwd) ||
      !path.isAbsolute(token.cwd) ||
      path.resolve(token.cwd) !== path.resolve(options.cwd) ||
      !CLAUDE_SESSION_ID_PATTERN.test(token.nativeThreadId) ||
      !claudeLifecycleBehaviorProfile(options.agentVersion)
    ) {
      return {
        status: "unsafe",
        reason: "candidate is not an exact Claude root-interactive session"
      };
    }
    const claudeHome = path.resolve(options.claudeHome ?? defaultClaudeHome());
    const summary = inspectClaudeHistoricalSession({
      projectsRoot: projectsRootPath(claudeHome),
      cwd: path.resolve(options.cwd),
      sessionId: token.nativeThreadId.toLowerCase(),
      agentVersion: options.agentVersion
    });
    if (!summary) {
      return {
        status: "unavailable",
        reason: "the Claude transcript no longer exists"
      };
    }
    const current: TerminalThreadLifecycleCandidate = {
      agent: "claude",
      nativeThreadId: summary.id,
      cwd: summary.cwd,
      source: "claude_transcript",
      rootInteractive: true,
      fileToken: summary.fileToken,
      agentVersion: options.agentVersion,
      sourceAgentVersion: summary.claudeVersion,
      updatedAtMs: summary.updatedAtMs,
      metadataFingerprint: summary.metadataFingerprint,
      candidateToken: summary.candidateToken
    };
    if (
      !sameClaudeThreadFileToken(token.fileToken, current.fileToken) ||
      token.metadataFingerprint !== current.metadataFingerprint ||
      token.version !== current.candidateToken.version ||
      claudeCandidateSourceAgentVersion(token) !==
        claudeCandidateSourceAgentVersion(current.candidateToken)
    ) {
      return {
        status: "changed",
        candidate: current,
        reason: "the Claude transcript changed after candidate discovery"
      };
    }
    return { status: "valid", candidate: current };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {
        status: "unavailable",
        reason: "the Claude transcript no longer exists"
      };
    }
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectClaudeHistoricalSession({
  projectsRoot,
  cwd,
  sessionId,
  agentVersion
}: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
  agentVersion: string;
}): ClaudeHistoricalSessionSummary | undefined {
  if (
    !isRealDirectory(projectsRoot) ||
    !CLAUDE_SESSION_ID_PATTERN.test(sessionId) ||
    !claudeLifecycleBehaviorProfile(agentVersion)
  ) {
    return undefined;
  }
  const relativePath = expectedTranscriptRelativePath(sessionId, cwd);
  const opened = openRelativeTranscript(projectsRoot, relativePath);
  if (!opened) {
    return undefined;
  }
  try {
    const transcriptPath = fs.realpathSync(
      path.join(projectsRoot, opened.relativePath)
    );
    const realProjectsRoot = fs.realpathSync(projectsRoot);
    const relative = path.relative(realProjectsRoot, transcriptPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Claude transcript resolves outside the projects directory");
    }
    const metadata = readClaudeHistoricalMetadata(
      opened.fd,
      opened.stat.size
    );
    if (!metadata) {
      return undefined;
    }
    if (
      metadata.sessionId !== sessionId ||
      !path.isAbsolute(metadata.cwd) ||
      normalizePath(metadata.cwd) !== normalizePath(cwd) ||
      !claudeLifecycleSourceVersionSupported(
        agentVersion,
        metadata.version
      ) ||
      metadata.isSidechain !== false ||
      metadata.entrypoint !== "cli" ||
      metadata.agentId !== undefined ||
      metadata.teamName !== undefined ||
      metadata.loopSession ||
      ![undefined, "interactive", "main"].includes(metadata.sessionKind)
    ) {
      return undefined;
    }
    const stable = fs.fstatSync(opened.fd);
    if (
      stable.dev !== opened.stat.dev ||
      stable.ino !== opened.stat.ino ||
      stable.size !== opened.stat.size ||
      stable.mtimeMs !== opened.stat.mtimeMs ||
      fs.realpathSync(path.join(projectsRoot, opened.relativePath)) !==
        transcriptPath
    ) {
      throw new Error("Claude transcript changed while it was inspected");
    }
    const fileToken: TerminalThreadFileToken = {
      path: transcriptPath,
      device: String(stable.dev),
      inode: String(stable.ino),
      size: stable.size,
      mtimeMs: stable.mtimeMs
    };
    const metadataFingerprint = createHash("sha256")
      .update(JSON.stringify({
        sessionId,
        cwd: path.resolve(cwd),
        version: metadata.version,
        entrypoint: metadata.entrypoint,
        sessionKind: metadata.sessionKind ?? null,
        transcriptPath
      }))
      .digest("hex");
    const tokenFields = {
      agent: "claude",
      nativeThreadId: sessionId,
      cwd: path.resolve(cwd),
      source: "claude_transcript",
      agentVersion,
      fileToken,
      metadataFingerprint
    } as const;
    const candidateToken: TerminalThreadLifecycleCandidateToken =
      metadata.version === agentVersion
        ? {
            schema: "agent-knock-knock/thread-candidate-token",
            version: 1,
            ...tokenFields
          }
        : {
            schema: "agent-knock-knock/thread-candidate-token",
            version: 2,
            ...tokenFields,
            sourceAgentVersion: metadata.version
          };
    return {
      id: sessionId,
      cwd: path.resolve(cwd),
      transcriptPath,
      updatedAtMs: stable.mtimeMs,
      claudeVersion: metadata.version,
      rootInteractive: true,
      fileToken,
      metadataFingerprint,
      candidateToken
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function claudeCandidateSourceAgentVersion(
  token: TerminalThreadLifecycleCandidateToken
): string {
  return token.version === 2 ? token.sourceAgentVersion : token.agentVersion;
}

function readClaudeHistoricalMetadata(
  fd: number,
  fileSize: number
): {
  sessionId: string;
  cwd: string;
  version: string;
  isSidechain: boolean;
  entrypoint: string;
  agentId?: string;
  teamName?: string;
  sessionKind?: string;
  loopSession: boolean;
} | undefined {
  if (fileSize <= 0 || !Number.isSafeInteger(fileSize)) {
    return undefined;
  }
  const bytesToRead = Math.min(
    fileSize,
    CLAUDE_HISTORICAL_METADATA_MAX_BYTES
  );
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
  if (bytesRead !== bytesToRead) {
    throw new Error("Claude transcript changed while metadata was read");
  }
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  const lastCompleteNewline = text.lastIndexOf("\n");
  if (lastCompleteNewline < 0) {
    if (fileSize > bytesRead) {
      throw new Error("Claude transcript metadata line exceeds the read limit");
    }
    return undefined;
  }
  const completeLines = text.slice(0, lastCompleteNewline).split("\n");
  for (const line of completeLines) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Claude transcript contains invalid root metadata JSONL");
    }
    if (!isRecord(parsed)) {
      throw new Error("Claude transcript root metadata must be an object");
    }
    const sessionId = nonEmptyString(parsed.sessionId);
    if (!sessionId) {
      continue;
    }
    const cwd = nonEmptyString(parsed.cwd);
    const version = nonEmptyString(parsed.version);
    const entrypoint = nonEmptyString(parsed.entrypoint);
    const hasIdentityMetadata =
      cwd !== undefined ||
      version !== undefined ||
      entrypoint !== undefined ||
      typeof parsed.isSidechain === "boolean" ||
      nonEmptyString(parsed.agentId) !== undefined ||
      nonEmptyString(parsed.teamName) !== undefined ||
      nonEmptyString(parsed.sessionKind) !== undefined;
    if (!hasIdentityMetadata) {
      // Verified Claude transcript profiles can prepend mode/permission-mode
      // records carrying only sessionId. Continue to the first full root row.
      continue;
    }
    if (!cwd || !version || !entrypoint || typeof parsed.isSidechain !== "boolean") {
      throw new Error("Claude transcript has incomplete root session metadata");
    }
    const sessionKind = nonEmptyString(parsed.sessionKind);
    return {
      sessionId: sessionId.toLowerCase(),
      cwd,
      version,
      isSidechain: parsed.isSidechain,
      entrypoint,
      agentId: nonEmptyString(parsed.agentId),
      teamName: nonEmptyString(parsed.teamName),
      sessionKind,
      loopSession:
        parsed.isLoop === true ||
        parsed.isLoopSession === true ||
        parsed.loopSession === true ||
        sessionKind === "loop"
    };
  }
  return undefined;
}

function sameClaudeThreadFileToken(
  left: TerminalThreadFileToken,
  right: TerminalThreadFileToken
): boolean {
  return left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

/**
 * Records the immutable file boundary immediately before AKK submits a turn.
 * No transcript contents are retained in conversation state.
 */
export function captureClaudeTranscriptAnchor(
  options: CaptureClaudeTranscriptAnchorOptions
): ClaudeTranscriptAnchor | undefined {
  const sessionId = nonEmptyString(options.sessionId);
  const cwd = nonEmptyString(options.cwd);
  const pid = positiveInteger(options.pid);
  if (!sessionId || !cwd || pid === undefined || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
    return undefined;
  }

  const agent = exactInteractiveAgent(options.agentRows, pid);
  const agentStartedAtMs = positiveInteger(agent?.startedAt);
  if (
    !agent ||
    agentStartedAtMs === undefined ||
    agent.sessionId !== sessionId ||
    normalizePath(agent.cwd) !== normalizePath(cwd) ||
    agent.status !== "idle"
  ) {
    return undefined;
  }

  const claudeHome = path.resolve(options.claudeHome ?? defaultClaudeHome());
  const projectsRoot = projectsRootPath(claudeHome);
  if (!isRealDirectory(projectsRoot)) {
    if (
      lstatOrUndefined(projectsRoot) !== undefined ||
      !isRealDirectory(claudeHome)
    ) {
      return undefined;
    }
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: expectedTranscriptRelativePath(sessionId, cwd),
      offset_bytes: 0,
      file_existed: false
    };
  }

  const located = locateTranscript(projectsRoot, sessionId);
  const relativePath = located?.relativePath ?? expectedTranscriptRelativePath(sessionId, cwd);
  if (!located) {
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: relativePath,
      offset_bytes: 0,
      file_existed: false
    };
  }

  try {
    if (located.stat.size > 0 && !fileEndsWithNewline(located.fd, located.stat.size)) {
      throw new Error("Claude transcript did not end at a complete JSONL record before send");
    }
    const stableStat = fs.fstatSync(located.fd);
    if (!sameStableTranscriptFile(located.stat, stableStat)) {
      throw new Error(
        "Claude transcript changed while its terminal submission anchor was captured"
      );
    }
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: located.relativePath,
      offset_bytes: located.stat.size,
      file_existed: true,
      device: String(located.stat.dev),
      inode: String(located.stat.ino)
    };
  } finally {
    fs.closeSync(located.fd);
  }
}

/**
 * Detects one completed Claude Code turn from the append-only local transcript.
 * The detector intentionally fails closed on identity, schema, rotation, prompt,
 * background-work, and chain ambiguity.
 */
export function detectClaudeTranscriptCompletion(
  request: TerminalDurableCompletionRequest,
  options: DetectClaudeTranscriptCompletionOptions
): TerminalCompletionEvidence | undefined {
  const snapshot = readClaudeTranscriptTurnSnapshot(request, options, "idle");
  if (!snapshot) {
    return undefined;
  }
  return completionFromRecords(snapshot);
}

/**
 * Observes completion after the exact bound Claude process is independently
 * proven dead. Unlike the ordinary live monitor detector, this API separates
 * a stable, fully inspected transcript with no completion from a transcript
 * that cannot be inspected or tied back to the durable native-acceptance
 * receipt. Callers may treat only `absent` as authority for orphan cleanup.
 */
export function observeClaudeDeadProcessTranscriptCompletion(
  request: TerminalDurableCompletionRequest,
  options: ObserveClaudeDeadProcessCompletionOptions
): ClaudeDeadProcessCompletionObservation {
  try {
    const snapshot = readClaudeTranscriptTurnSnapshot(
      request,
      options,
      "idle",
      "verified_dead_process"
    );
    if (!snapshot) {
      return {
        status: "unverifiable",
        reason: "Claude transcript could not be read with exact dead-process authority"
      };
    }
    const observedAcceptance = acceptanceEvidenceFromSnapshot(snapshot);
    if (!observedAcceptance) {
      throw new Error(
        "the exact accepted Claude prompt is absent from the anchored transcript"
      );
    }
    const persistedAcceptance = validateTerminalSubmissionAcceptanceEvidence(
      options.acceptanceEvidence,
      {
        source: "claude_transcript",
        nativeThreadId: snapshot.sessionId,
        requestHash: snapshot.expectedRequestHash
      }
    );
    assertSameClaudeTranscriptAcceptance(
      persistedAcceptance,
      observedAcceptance,
      snapshot
    );
    const completion = completionFromRecords(snapshot, {
      requireVerifiableCompletionSignal: true
    });
    return completion
      ? { status: "present", completion }
      : { status: "absent" };
  } catch (error) {
    return {
      status: "unverifiable",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Detects native acceptance as soon as Claude appends the unique root user
 * row matching the managed request after the immutable pre-send byte anchor.
 * Unlike completion detection, acceptance does not require the agent to be
 * idle because the row is normally written while Claude is working.
 */
export function detectClaudeTranscriptAcceptance(
  request: TerminalDurableCompletionRequest,
  options: DetectClaudeTranscriptCompletionOptions
): ClaudeTranscriptAcceptanceEvidence | undefined {
  const snapshot = readClaudeTranscriptTurnSnapshot(request, options);
  if (!snapshot) {
    return undefined;
  }
  return acceptanceEvidenceFromSnapshot(snapshot);
}

function acceptanceEvidenceFromSnapshot(
  snapshot: ClaudeTranscriptTurnSnapshot
): ClaudeTranscriptAcceptanceEvidence | undefined {
  const prompt = matchingManagedPrompt(snapshot);
  if (!prompt) {
    return undefined;
  }
  const promptUuid = uuidValue(prompt.uuid);
  const claudeVersion = nonEmptyString(prompt.version);
  if (!promptUuid || !claudeVersion) {
    throw new Error("matched Claude transcript prompt has no stable native identity");
  }
  const acceptedAt = String(prompt.timestamp);
  const evidenceBase = {
    source: "claude_transcript" as const,
    kind: "native_user_turn" as const,
    nativeThreadId: snapshot.sessionId,
    requestHash: snapshot.expectedRequestHash,
    acceptanceId: promptUuid,
    acceptedAt,
    anchorFingerprint: claudeTranscriptAnchorFingerprint(snapshot.anchor),
    metadata: {
      prompt_uuid: promptUuid,
      claude_version: claudeVersion,
      transcript_file_id: snapshot.transcriptFileId,
      anchor_offset_bytes: snapshot.anchor.offset_bytes,
      observed_end_offset_bytes: snapshot.observedEndOffsetBytes,
      agent_started_at_ms: snapshot.anchor.agent_started_at_ms
    }
  };
  return {
    ...evidenceBase,
    evidenceFingerprint: sha256Hex(JSON.stringify(evidenceBase))
  };
}

function assertSameClaudeTranscriptAcceptance(
  persisted: TerminalSubmissionAcceptanceEvidence,
  observed: ClaudeTranscriptAcceptanceEvidence,
  snapshot: ClaudeTranscriptTurnSnapshot
): void {
  const persistedMetadata = isRecord(persisted.metadata)
    ? persisted.metadata
    : undefined;
  const observedMetadata = isRecord(observed.metadata)
    ? observed.metadata
    : undefined;
  const persistedEndOffset = nonNegativeInteger(
    persistedMetadata?.observed_end_offset_bytes
  );
  if (
    persisted.source !== "claude_transcript" ||
    persisted.kind !== "native_user_turn" ||
    persisted.acceptanceId !== observed.acceptanceId ||
    persisted.acceptedAt !== observed.acceptedAt ||
    persisted.anchorFingerprint !== observed.anchorFingerprint ||
    !persistedMetadata ||
    !observedMetadata ||
    persistedMetadata.prompt_uuid !== observedMetadata.prompt_uuid ||
    persistedMetadata.claude_version !== observedMetadata.claude_version ||
    persistedMetadata.transcript_file_id !==
      observedMetadata.transcript_file_id ||
    persistedMetadata.anchor_offset_bytes !==
      observedMetadata.anchor_offset_bytes ||
    persistedMetadata.agent_started_at_ms !==
      observedMetadata.agent_started_at_ms ||
    persistedEndOffset === undefined ||
    persistedEndOffset <= snapshot.anchor.offset_bytes ||
    persistedEndOffset > snapshot.observedEndOffsetBytes
  ) {
    throw new Error(
      "persisted Claude acceptance evidence does not match the exact anchored prompt"
    );
  }
}

/**
 * Detects exactly one unresolved foreground Bash tool use for the current
 * AKK-managed Claude turn. It uses the same anchored, owner-private,
 * no-follow, bounded, stable transcript read as durable completion and fails
 * closed on identity changes, completed turns, background work, or ambiguity.
 */
export function detectClaudeTranscriptPendingApproval(
  request: TerminalDurableCompletionRequest,
  options: DetectClaudeTranscriptCompletionOptions
): ClaudeTranscriptPendingApprovalEvidence | undefined {
  const snapshot = readClaudeTranscriptTurnSnapshot(request, options);
  if (!snapshot) {
    return undefined;
  }
  return pendingApprovalFromRecords(snapshot);
}

function readClaudeTranscriptTurnSnapshot(
  request: TerminalDurableCompletionRequest,
  options: DetectClaudeTranscriptCompletionOptions,
  requiredAgentStatus?: "idle",
  readMode: "live_monitor" | "verified_dead_process" = "live_monitor"
): ClaudeTranscriptTurnSnapshot | undefined {
  const unavailable = (reason: string): undefined => {
    if (readMode === "verified_dead_process") {
      throw new Error(reason);
    }
    return undefined;
  };
  const anchor = transcriptAnchorFromContext(request.context);
  if (!anchor) {
    return unavailable("Claude transcript anchor is unavailable");
  }

  const sessionId = nonEmptyString(request.sessionId);
  const cwd = nonEmptyString(request.cwd);
  const expectedRequestHash = nonEmptyString(request.requestHash);
  const requestTextHash = exactRequestFingerprint(request.requestText);
  const expectedPromptText = exactPromptText(request.requestText);
  const startedAtMs = validTimestampMs(request.startedAt);
  const capturedAtMs = validTimestampMs(anchor.captured_at);
  if (
    !sessionId ||
    !cwd ||
    !expectedRequestHash ||
    !requestTextHash ||
    !expectedPromptText ||
    expectedRequestHash !== requestTextHash ||
    startedAtMs === undefined ||
    capturedAtMs === undefined
  ) {
    return unavailable(
      "Claude transcript request metadata cannot be verified"
    );
  }
  if (
    anchor.schema_version !== CLAUDE_TRANSCRIPT_ANCHOR_VERSION ||
    anchor.session_id !== sessionId ||
    normalizePath(anchor.cwd) !== normalizePath(cwd) ||
    !CLAUDE_SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new Error("Claude transcript anchor does not match the managed terminal turn");
  }

  const runtimePid = runtimePidFromContext(request.context);
  if (runtimePid === undefined || runtimePid !== anchor.pid) {
    throw new Error("Claude transcript anchor PID does not match the active terminal runtime");
  }
  const agent = exactInteractiveAgent(options.agentRows, anchor.pid);
  if (!agent) {
    throw new Error("the exact Claude process is absent from the local agent registry");
  }
  if (
    agent.startedAt !== anchor.agent_started_at_ms ||
    agent.sessionId !== sessionId ||
    normalizePath(agent.cwd) !== normalizePath(cwd)
  ) {
    throw new Error("the Claude process session identity changed after the managed send");
  }
  if (requiredAgentStatus && agent.status !== requiredAgentStatus) {
    return unavailable(
      `the exact Claude process is ${agent.status}, not ${requiredAgentStatus}`
    );
  }

  const projectsRoot = projectsRootPath(
    path.resolve(options.claudeHome ?? defaultClaudeHome())
  );
  if (!isRealDirectory(projectsRoot)) {
    return unavailable("Claude transcript projects directory is unavailable");
  }
  const opened = openAnchoredTranscript(projectsRoot, anchor);
  if (!opened) {
    return unavailable("the anchored Claude transcript is unavailable");
  }

  try {
    if (
      anchor.file_existed &&
      (String(opened.stat.dev) !== anchor.device || String(opened.stat.ino) !== anchor.inode)
    ) {
      throw new Error("Claude transcript was replaced or rotated after the managed send");
    }
    if (opened.stat.size < anchor.offset_bytes) {
      throw new Error("Claude transcript was truncated after the managed send");
    }

    const bytesToRead = opened.stat.size - anchor.offset_bytes;
    if (bytesToRead === 0) {
      return unavailable(
        "the anchored Claude transcript contains no post-send records"
      );
    }
    const maxTurnBytes = positiveInteger(options.maxTurnBytes) ??
      CLAUDE_TRANSCRIPT_MAX_TURN_BYTES;
    if (bytesToRead > maxTurnBytes) {
      throw new Error("Claude transcript turn exceeded the bounded local read limit");
    }
    if (
      readMode === "verified_dead_process" &&
      !fileEndsWithNewline(opened.fd, opened.stat.size)
    ) {
      throw new Error(
        "Claude transcript ends with an incomplete JSONL record"
      );
    }

    const records = readCompleteJsonlRecords(
      opened.fd,
      anchor.offset_bytes,
      bytesToRead
    );
    const stableStat = fs.fstatSync(opened.fd);
    if (!sameStableTranscriptFile(opened.stat, stableStat)) {
      return unavailable(
        "Claude transcript changed while dead-process completion was inspected"
      );
    }
    if (records.length === 0) {
      return unavailable(
        "Claude transcript contains no complete post-send records"
      );
    }
    const fileIdentity = `${opened.stat.dev}:${opened.stat.ino}`;
    return {
      anchor,
      records,
      sessionId,
      cwd,
      expectedRequestHash,
      expectedPromptText,
      transcriptFileId: transcriptFileId(sessionId, fileIdentity),
      observedEndOffsetBytes: opened.stat.size
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function matchingManagedPrompt(
  snapshot: ClaudeTranscriptTurnSnapshot
): TranscriptRecord | undefined {
  const promptCandidates = snapshot.records.filter((record) => {
    const promptText = userPromptText(record);
    return record.type === "user" &&
      isRecord(record.message) &&
      record.message.role === "user" &&
      record.isSidechain !== true &&
      nonEmptyString(record.agentId) === undefined &&
      record.sessionId === snapshot.sessionId &&
      normalizePath(record.cwd) === normalizePath(snapshot.cwd) &&
      validTimestampMs(record.timestamp) !== undefined &&
      promptText !== undefined &&
      exactPromptText(promptText) === snapshot.expectedPromptText &&
      exactRequestFingerprint(promptText) === snapshot.expectedRequestHash;
  });
  if (promptCandidates.length === 0) {
    return undefined;
  }
  if (promptCandidates.length !== 1) {
    throw new Error("multiple Claude transcript prompts matched the managed request");
  }

  const prompt = promptCandidates[0];
  const promptUuid = uuidValue(prompt.uuid);
  if (!promptUuid) {
    throw new Error("matched Claude transcript prompt has no stable UUID");
  }
  assertSupportedRecord(prompt, snapshot.sessionId, snapshot.cwd);
  return prompt;
}

function completionFromRecords(
  snapshot: ClaudeTranscriptTurnSnapshot,
  options: { requireVerifiableCompletionSignal?: boolean } = {}
): TerminalCompletionEvidence | undefined {
  const {
    records,
    sessionId,
    transcriptFileId: fileId
  } = snapshot;
  const prompt = matchingManagedPrompt(snapshot);
  if (!prompt) {
    return undefined;
  }
  const promptUuid = uuidValue(prompt.uuid);
  if (!promptUuid) {
    throw new Error("matched Claude transcript prompt has no stable UUID");
  }

  const promptIndex = records.indexOf(prompt);
  const nextHumanPromptIndex = records.findIndex((record, index) =>
    index > promptIndex &&
    record.type === "user" &&
    isRecord(record.message) &&
    record.message.role === "user" &&
    record.isSidechain !== true &&
    nonEmptyString(record.agentId) === undefined &&
    userPromptText(record) !== undefined
  );
  if (
    options.requireVerifiableCompletionSignal === true &&
    nextHumanPromptIndex >= 0
  ) {
    const nextHumanPrompt = records[nextHumanPromptIndex];
    if (!nextHumanPrompt || uuidValue(nextHumanPrompt.uuid) === undefined) {
      throw new Error(
        "Claude transcript next human prompt has no stable UUID"
      );
    }
    assertSupportedRecord(nextHumanPrompt, sessionId, snapshot.cwd);
  }
  const turnRecords = records.slice(
    promptIndex,
    nextHumanPromptIndex < 0 ? records.length : nextHumanPromptIndex
  );
  if (
    options.requireVerifiableCompletionSignal === true &&
    turnRecords.some((record) =>
      (
        ["user", "assistant", "system"].includes(String(record.type)) ||
        hasTurnCompletionSignal(record)
      ) && uuidValue(record.uuid) === undefined
    )
  ) {
    throw new Error(
      "Claude transcript turn contains a completion-relevant record without a stable UUID"
    );
  }
  const recordsByUuid = new Map<string, TranscriptRecord>();
  for (const record of turnRecords) {
    const uuid = uuidValue(record.uuid);
    if (!uuid) {
      continue;
    }
    if (recordsByUuid.has(uuid)) {
      throw new Error("Claude transcript contains a duplicate record UUID");
    }
    recordsByUuid.set(uuid, record);
  }
  assertParentsPrecedeChildren(turnRecords, recordsByUuid);
  const descendants = turnRecords.filter((record) =>
    uuidValue(record.uuid) !== undefined &&
    descendantChain(recordsByUuid, promptUuid, record) !== undefined
  );
  if (descendants.length !== recordsByUuid.size) {
    throw new Error("Claude transcript turn contains an unlinked UUID branch");
  }
  for (const record of descendants) {
    assertSupportedRecord(record, sessionId);
  }
  assertSameClaudeVersion(...descendants);
  const absentOrUnverifiable = (): undefined => {
    if (
      options.requireVerifiableCompletionSignal === true &&
      descendants.some(hasTurnCompletionSignal)
    ) {
      throw new Error(
        "Claude transcript contains a completion signal without one complete verifiable completion chain"
      );
    }
    return undefined;
  };
  if (descendants.some((record) =>
    record.isSidechain === true ||
    nonEmptyString(record.agentId) !== undefined ||
    hasUnresolvedBackgroundWork(record)
  )) {
    return absentOrUnverifiable();
  }
  if (hasUnresolvedToolUse(descendants)) {
    return absentOrUnverifiable();
  }
  if (descendants.some(hasBlockingStopSummary)) {
    return absentOrUnverifiable();
  }

  const durations = descendantRecords(
    turnRecords,
    recordsByUuid,
    promptUuid,
    (record) => record.type === "system" && record.subtype === "turn_duration"
  );
  if (durations.length > 1) {
    throw new Error("Claude transcript turn contains multiple turn_duration records");
  }
  const duration = durations[0];
  if (!duration) {
    const failures = descendantRecords(
      turnRecords,
      recordsByUuid,
      promptUuid,
      (record) =>
        record.type === "assistant" &&
        record.isApiErrorMessage === true &&
        nonEmptyString(record.error) !== undefined
    );
    const failure = failures.at(-1);
    const lastDescendant = [...turnRecords].reverse().find((record) =>
      uuidValue(record.uuid) !== undefined &&
      descendantChain(recordsByUuid, promptUuid, record) !== undefined
    );
    if (!failure || failure !== lastDescendant) {
      return absentOrUnverifiable();
    }

    assertSupportedRecord(failure, sessionId);
    assertSameClaudeVersion(prompt, failure);
    const error = safeErrorCode(failure.error);
    const assistantText = assistantTextForMessage(
      turnRecords,
      recordsByUuid,
      promptUuid,
      failure
    );
    return {
      source: "durable",
      outcome: "failure",
      text: boundedRedactedText(
        assistantText || `Claude Code stopped with ${error}.`
      ),
      timestamp: nonEmptyString(failure.timestamp),
      id: uuidValue(failure.uuid),
      confidence: "high",
      metadata: {
        match: "claude_transcript_api_error",
        session_id: sessionId,
        prompt_uuid: promptUuid,
        error,
        transcript_schema: "claude_code_jsonl_v2",
        transcript_file_id: fileId
      }
    };
  }
  assertSupportedRecord(duration, sessionId);
  if (validTimestampMs(duration.timestamp) === undefined) {
    throw new Error("Claude turn_duration has no valid timestamp");
  }

  const chain = descendantChain(recordsByUuid, promptUuid, duration);
  if (!chain) {
    return absentOrUnverifiable();
  }
  const finalAssistant = [...chain].reverse().find((record) =>
    record.type === "assistant" &&
    isRecord(record.message) &&
    record.message.role === "assistant" &&
    record.message.stop_reason === "end_turn"
  );
  if (!finalAssistant) {
    throw new Error("Claude turn_duration was not linked to an end_turn assistant record");
  }
  assertSupportedRecord(finalAssistant, sessionId);
  assertSameClaudeVersion(prompt, finalAssistant, duration);

  const finalMessage = isRecord(finalAssistant.message)
    ? finalAssistant.message
    : undefined;
  const messageId = uuidValue(finalMessage?.id);
  if (!messageId) {
    throw new Error("Claude final assistant message has no stable UUID");
  }
  const assistantText = assistantTextForMessage(
    turnRecords,
    recordsByUuid,
    promptUuid,
    finalAssistant
  );
  if (!assistantText) {
    if (options.requireVerifiableCompletionSignal === true) {
      throw new Error(
        "Claude completion signal has no verifiable assistant text"
      );
    }
    return undefined;
  }
  const promptId = nonEmptyString(prompt.promptId);
  return {
    source: "durable",
    outcome: "success",
    text: boundedRedactedText(assistantText),
    timestamp: nonEmptyString(duration.timestamp),
    id: uuidValue(duration.uuid),
    confidence: "high",
    metadata: {
      match: "claude_transcript_turn_duration",
      session_id: sessionId,
      prompt_uuid: promptUuid,
      ...(promptId ? { prompt_id: promptId } : {}),
      assistant_message_id: messageId,
      claude_version: nonEmptyString(finalAssistant.version),
      transcript_schema: "claude_code_jsonl_v2",
      transcript_file_id: fileId
    }
  };
}

function pendingApprovalFromRecords(
  snapshot: ClaudeTranscriptTurnSnapshot
): ClaudeTranscriptPendingApprovalEvidence | undefined {
  const prompt = matchingManagedPrompt(snapshot);
  if (!prompt) {
    return undefined;
  }
  const promptUuid = uuidValue(prompt.uuid);
  if (!promptUuid) {
    throw new Error("matched Claude transcript prompt has no stable UUID");
  }

  const promptIndex = snapshot.records.indexOf(prompt);
  const nextHumanPrompt = snapshot.records.find((record, index) =>
    index > promptIndex &&
    record.type === "user" &&
    isRecord(record.message) &&
    record.message.role === "user" &&
    record.isSidechain !== true &&
    nonEmptyString(record.agentId) === undefined &&
    userPromptText(record) !== undefined
  );
  if (nextHumanPrompt) {
    return undefined;
  }

  const turnRecords = snapshot.records.slice(promptIndex);
  if (
    turnRecords.some(hasUnresolvedBackgroundWork) ||
    turnRecords.some((record) =>
      uuidValue(record.uuid) === undefined &&
      (record.type === "assistant" || record.type === "user" || record.type === "system")
    )
  ) {
    return undefined;
  }
  const recordsByUuid = new Map<string, TranscriptRecord>();
  for (const record of turnRecords) {
    const recordUuid = uuidValue(record.uuid);
    if (!recordUuid) {
      continue;
    }
    if (recordsByUuid.has(recordUuid)) {
      throw new Error("Claude transcript contains a duplicate record UUID");
    }
    recordsByUuid.set(recordUuid, record);
  }
  assertParentsPrecedeChildren(turnRecords, recordsByUuid);

  const descendants = turnRecords.filter((record) =>
    uuidValue(record.uuid) !== undefined &&
    descendantChain(recordsByUuid, promptUuid, record) !== undefined
  );
  if (descendants.length !== recordsByUuid.size) {
    throw new Error("Claude transcript turn contains an unlinked UUID branch");
  }
  for (const record of descendants) {
    assertSupportedRecord(record, snapshot.sessionId);
  }
  assertSameClaudeVersion(...descendants);
  if (descendants.some((record) =>
    record.type !== "user" &&
    record.type !== "assistant" &&
    record.type !== "attachment"
  )) {
    return undefined;
  }
  if (descendants.some((record) =>
    record.isSidechain === true ||
    nonEmptyString(record.agentId) !== undefined ||
    hasUnresolvedBackgroundWork(record)
  )) {
    return undefined;
  }
  if (descendants.some((record) =>
    hasTurnCompletionSignal(record) ||
    record.subtype === "stop_hook_summary"
  )) {
    return undefined;
  }

  const lastDescendant = descendants.at(-1);
  if (!lastDescendant) {
    return undefined;
  }
  const linearChain = descendantChain(recordsByUuid, promptUuid, lastDescendant);
  if (!linearChain || linearChain.length !== descendants.length) {
    return undefined;
  }

  interface ToolUseState {
    id: string;
    name: string;
    input: Record<string, unknown>;
    owner: TranscriptRecord;
    ownerUuid: string;
    ownerToolUseCount: number;
  }
  interface ToolResultState {
    parentUuid?: string;
    sourceAssistantUuid?: string;
  }
  const toolUses = new Map<string, ToolUseState>();
  const toolResults = new Map<string, ToolResultState>();
  for (const record of descendants) {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const ownerToolUseCount = content.filter((block) =>
      isRecord(block) && block.type === "tool_use"
    ).length;
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "tool_use") {
        const id = nonEmptyString(block.id);
        const name = nonEmptyString(block.name);
        const input = isRecord(block.input) ? block.input : undefined;
        const ownerUuid = uuidValue(record.uuid);
        if (!id || !name || !input || !ownerUuid) {
          throw new Error("Claude transcript contains a malformed tool_use record");
        }
        if (toolUses.has(id)) {
          throw new Error("Claude transcript contains a duplicate tool_use id");
        }
        toolUses.set(id, {
          id,
          name,
          input,
          owner: record,
          ownerUuid,
          ownerToolUseCount
        });
      } else if (block.type === "tool_result") {
        const id = nonEmptyString(block.tool_use_id);
        if (!id) {
          throw new Error("Claude transcript contains a malformed tool_result record");
        }
        if (toolResults.has(id)) {
          throw new Error("Claude transcript contains a duplicate tool_result id");
        }
        toolResults.set(id, {
          parentUuid: uuidValue(record.parentUuid),
          sourceAssistantUuid: uuidValue(record.sourceToolAssistantUUID)
        });
      }
    }
  }

  for (const [id, result] of toolResults) {
    const toolUse = toolUses.get(id);
    if (
      !toolUse ||
      result.parentUuid !== toolUse.ownerUuid ||
      result.sourceAssistantUuid !== toolUse.ownerUuid
    ) {
      throw new Error("Claude transcript contains an ambiguously linked tool_result");
    }
  }
  if ([...toolUses.values()].some((toolUse) => toolUse.ownerToolUseCount !== 1)) {
    return undefined;
  }
  const unresolved = [...toolUses.values()].filter((toolUse) =>
    !toolResults.has(toolUse.id)
  );
  if (unresolved.length !== 1) {
    return undefined;
  }

  const pending = unresolved[0];
  const pendingMessage = isRecord(pending.owner.message)
    ? pending.owner.message
    : undefined;
  if (
    pending.name !== "Bash" ||
    pending.owner !== lastDescendant ||
    pendingMessage?.role !== "assistant" ||
    pendingMessage.stop_reason !== "tool_use"
  ) {
    return undefined;
  }

  const command = pending.input.command;
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(command)
  ) {
    return undefined;
  }
  const commandCwd = normalizePath(pending.owner.cwd);
  if (!commandCwd || commandCwd !== normalizePath(snapshot.cwd)) {
    return undefined;
  }
  const claudeVersion = nonEmptyString(pending.owner.version);
  if (!claudeVersion) {
    throw new Error("Claude pending Bash tool use has no compatible version");
  }
  if (!isCompatiblePendingApprovalClaudeVersion(claudeVersion)) {
    return undefined;
  }

  const commandSha256 = sha256Hex(command);
  const evidenceFingerprint = sha256Hex(JSON.stringify({
    schema_version: 1,
    source: "claude_transcript",
    kind: "run_command",
    session_id: snapshot.sessionId,
    cwd: commandCwd,
    pid: snapshot.anchor.pid,
    agent_started_at_ms: snapshot.anchor.agent_started_at_ms,
    anchor_offset_bytes: snapshot.anchor.offset_bytes,
    observed_end_offset_bytes: snapshot.observedEndOffsetBytes,
    prompt_uuid: promptUuid,
    assistant_uuid: pending.ownerUuid,
    tool_use_id: pending.id,
    claude_version: claudeVersion,
    transcript_file_id: snapshot.transcriptFileId,
    request_sha256: snapshot.expectedRequestHash,
    command_sha256: commandSha256
  }));
  return {
    source: "claude_transcript",
    kind: "run_command",
    command,
    cwd: commandCwd,
    toolName: "Bash",
    toolUseId: pending.id,
    promptUuid,
    assistantUuid: pending.ownerUuid,
    claudeVersion,
    transcriptFileId: snapshot.transcriptFileId,
    commandSha256,
    evidenceFingerprint,
    observedEndOffsetBytes: snapshot.observedEndOffsetBytes
  };
}

function transcriptAnchorFromContext(context: unknown): ClaudeTranscriptAnchor | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  const nativeTakeover = isRecord(context.nativeTakeover)
    ? context.nativeTakeover
    : undefined;
  const value = nativeTakeover?.claude_transcript_anchor ?? context.claudeTranscriptAnchor;
  if (!isRecord(value)) {
    return undefined;
  }
  const schemaVersion = Number(value.schema_version);
  const sessionId = nonEmptyString(value.session_id);
  const cwd = nonEmptyString(value.cwd);
  const pid = positiveInteger(value.pid);
  const agentStartedAtMs = positiveInteger(value.agent_started_at_ms);
  const capturedAt = nonEmptyString(value.captured_at);
  const relativePath = nonEmptyString(value.relative_path);
  const offsetBytes = nonNegativeInteger(value.offset_bytes);
  const device = nonEmptyString(value.device);
  const inode = nonEmptyString(value.inode);
  const fileExisted = value.file_existed;
  if (
    schemaVersion !== CLAUDE_TRANSCRIPT_ANCHOR_VERSION ||
    !sessionId ||
    !cwd ||
    pid === undefined ||
    agentStartedAtMs === undefined ||
    !capturedAt ||
    validTimestampMs(capturedAt) === undefined ||
    !relativePath ||
    offsetBytes === undefined ||
    typeof fileExisted !== "boolean" ||
    (
      fileExisted
        ? !decimalFileIdentity(device) || !decimalFileIdentity(inode)
        : offsetBytes !== 0 || device !== undefined || inode !== undefined
    )
  ) {
    throw new Error("Claude transcript anchor is invalid");
  }
  return {
    schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
    session_id: sessionId,
    cwd,
    pid,
    agent_started_at_ms: agentStartedAtMs,
    captured_at: capturedAt,
    relative_path: relativePath,
    offset_bytes: offsetBytes,
    file_existed: fileExisted,
    ...(device ? { device } : {}),
    ...(inode ? { inode } : {})
  };
}

function openAnchoredTranscript(
  projectsRoot: string,
  anchor: ClaudeTranscriptAnchor
): OpenTranscript | undefined {
  if (path.basename(anchor.relative_path) !== `${anchor.session_id}.jsonl`) {
    throw new Error("Claude transcript anchor filename does not match its session");
  }
  const candidates = locateTranscriptCandidates(projectsRoot, anchor.session_id);
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      fs.closeSync(candidate.fd);
    }
    throw new Error("multiple local Claude transcripts matched the active session");
  }
  const candidate = candidates[0];
  if (candidate) {
    if (anchor.file_existed && candidate.relativePath !== anchor.relative_path) {
      fs.closeSync(candidate.fd);
      throw new Error("Claude transcript moved after the managed send");
    }
    return candidate;
  }
  if (anchor.file_existed) {
    throw new Error("Claude transcript disappeared after the managed send");
  }
  return undefined;
}

function locateTranscript(
  projectsRoot: string,
  sessionId: string
): OpenTranscript | undefined {
  const candidates = locateTranscriptCandidates(projectsRoot, sessionId);
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      fs.closeSync(candidate.fd);
    }
    throw new Error("multiple local Claude transcripts matched the active session");
  }
  return candidates[0];
}

function locateTranscriptCandidates(
  projectsRoot: string,
  sessionId: string
): OpenTranscript[] {
  const candidates: OpenTranscript[] = [];
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = path.join(entry.name, `${sessionId}.jsonl`);
    const candidate = openRelativeTranscript(projectsRoot, relativePath);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function openRelativeTranscript(
  projectsRoot: string,
  relativePath: string
): OpenTranscript | undefined {
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.length !== 2 ||
    !segments[0] ||
    segments[0] === "." ||
    segments[0] === ".." ||
    !CLAUDE_SESSION_ID_PATTERN.test(path.basename(segments[1], ".jsonl")) ||
    segments[1] !== `${path.basename(segments[1], ".jsonl")}.jsonl`
  ) {
    throw new Error("Claude transcript anchor contains an invalid relative path");
  }
  const projectDirectory = path.join(projectsRoot, segments[0]);
  const directoryStat = lstatOrUndefined(projectDirectory);
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return undefined;
  }
  const transcriptPath = path.join(projectDirectory, segments[1]);
  const fileStat = lstatOrUndefined(transcriptPath);
  if (!fileStat) {
    return undefined;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Claude transcript must be a non-symlink regular file");
  }

  const fd = fs.openSync(
    transcriptPath,
    fs.constants.O_RDONLY | NO_FOLLOW_FLAG
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("Claude transcript must be a regular file");
    }
    assertPrivateTranscriptFile(stat);
    return {
      fd,
      stat,
      relativePath: path.join(segments[0], segments[1])
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readCompleteJsonlRecords(
  fd: number,
  offset: number,
  length: number
): TranscriptRecord[] {
  const buffer = Buffer.allocUnsafe(length);
  let readTotal = 0;
  while (readTotal < length) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      readTotal,
      length - readTotal,
      offset + readTotal
    );
    if (bytesRead === 0) {
      break;
    }
    readTotal += bytesRead;
  }
  if (readTotal !== length) {
    throw new Error("Claude transcript changed while it was being read");
  }
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    return [];
  }

  const text = buffer.subarray(0, buffer.length - 1).toString("utf8");
  const records: TranscriptRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Claude transcript contains an invalid complete JSONL record");
    }
    if (!isRecord(parsed)) {
      throw new Error("Claude transcript contains a non-object JSONL record");
    }
    records.push(parsed);
  }
  return records;
}

function descendantRecords(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  ancestorUuid: string,
  predicate: (record: TranscriptRecord) => boolean
): TranscriptRecord[] {
  return records.filter((record) =>
    predicate(record) &&
    descendantChain(recordsByUuid, ancestorUuid, record) !== undefined
  );
}

function assertParentsPrecedeChildren(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>
): void {
  const indexes = new Map<TranscriptRecord, number>(
    records.map((record, index) => [record, index])
  );
  for (const record of records) {
    const parentUuid = uuidValue(record.parentUuid);
    const parent = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
    if (parent && (indexes.get(parent) ?? Number.POSITIVE_INFINITY) >=
      (indexes.get(record) ?? Number.NEGATIVE_INFINITY)) {
      throw new Error("Claude transcript parent UUID does not precede its child record");
    }
  }
}

function descendantChain(
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  ancestorUuid: string,
  descendant: TranscriptRecord
): TranscriptRecord[] | undefined {
  const reversed: TranscriptRecord[] = [];
  let current: TranscriptRecord | undefined = descendant;
  const visited = new Set<string>();
  while (current) {
    const currentUuid = uuidValue(current.uuid);
    if (!currentUuid || visited.has(currentUuid)) {
      return undefined;
    }
    visited.add(currentUuid);
    reversed.push(current);
    if (currentUuid === ancestorUuid) {
      return reversed.reverse();
    }
    const parentUuid = uuidValue(current.parentUuid);
    current = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
  }
  return undefined;
}

function assistantTextForMessage(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  promptUuid: string,
  finalAssistant: TranscriptRecord
): string | undefined {
  const message = isRecord(finalAssistant.message) ? finalAssistant.message : undefined;
  const messageId = nonEmptyString(message?.id);
  if (!messageId) {
    return textFromAssistantRecord(finalAssistant);
  }
  const parts = records.flatMap((record): string[] => {
    const candidateMessage = isRecord(record.message) ? record.message : undefined;
    if (
      record.type !== "assistant" ||
      candidateMessage?.role !== "assistant" ||
      candidateMessage.id !== messageId ||
      descendantChain(recordsByUuid, promptUuid, record) === undefined
    ) {
      return [];
    }
    const text = textFromAssistantRecord(record);
    return text ? [text] : [];
  });
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function textFromAssistantRecord(record: TranscriptRecord): string | undefined {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.flatMap((block): string[] =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  ).join("\n").trim();
  return text || undefined;
}

function userPromptText(record: TranscriptRecord): string | undefined {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  return typeof content === "string" ? content : undefined;
}

function hasUnresolvedBackgroundWork(record: TranscriptRecord): boolean {
  if ([
    record.pendingBackgroundAgentCount,
    record.pendingWorkflowCount
  ].some((value) =>
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) !== 0)
  )) {
    return true;
  }
  if (
    record.type === "assistant" &&
    isRecord(record.message) &&
    Array.isArray(record.message.content)
  ) {
    for (const block of record.message.content) {
      if (!isRecord(block) || block.type !== "tool_use") {
        continue;
      }
      const toolName = nonEmptyString(block.name)?.toLowerCase();
      if (
        toolName?.startsWith("cron") ||
        toolName === "agent" ||
        toolName === "sendmessage" ||
        structuredBoolean(block.input, ["run_in_background", "runInBackground"]) === true
      ) {
        return true;
      }
    }
  }
  const toolUseResult = isRecord(record.toolUseResult)
    ? record.toolUseResult
    : undefined;
  const backgroundStatus = nonEmptyString(toolUseResult?.status);
  return nonEmptyString(toolUseResult?.backgroundTaskId) !== undefined ||
    structuredBoolean(toolUseResult, ["isAsync"]) === true ||
    (
      backgroundStatus !== undefined &&
      ["async_launched", "remote_launched", "teammate_spawned"].includes(backgroundStatus)
    ) ||
    structuredBoolean(toolUseResult, [
    "run_in_background",
    "runInBackground",
    "is_background",
    "isBackground",
    "backgroundedByUser",
    "assistantAutoBackgrounded"
  ]) === true;
}

function hasUnresolvedToolUse(records: readonly TranscriptRecord[]): boolean {
  const toolUses = new Map<string, { count: number; ownerUuid?: string }>();
  const toolResults = new Map<string, {
    count: number;
    parentUuid?: string;
    sourceAssistantUuid?: string;
  }>();
  let malformed = false;
  for (const record of records) {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "tool_use") {
        const id = nonEmptyString(block.id);
        if (id) {
          const existing = toolUses.get(id);
          toolUses.set(id, {
            count: (existing?.count ?? 0) + 1,
            ownerUuid: uuidValue(record.uuid)
          });
        } else {
          malformed = true;
        }
      }
      if (block.type === "tool_result") {
        const id = nonEmptyString(block.tool_use_id);
        if (id) {
          const existing = toolResults.get(id);
          toolResults.set(id, {
            count: (existing?.count ?? 0) + 1,
            parentUuid: uuidValue(record.parentUuid),
            sourceAssistantUuid: uuidValue(record.sourceToolAssistantUUID)
          });
        } else {
          malformed = true;
        }
      }
    }
  }
  return malformed ||
    [...toolUses].some(([id, toolUse]) => {
      const result = toolResults.get(id);
      return toolUse.count !== 1 ||
        result?.count !== 1 ||
        !toolUse.ownerUuid ||
        result.parentUuid !== toolUse.ownerUuid ||
        result.sourceAssistantUuid !== toolUse.ownerUuid;
    }) ||
    [...toolResults].some(([id, result]) =>
      result.count !== 1 || toolUses.get(id)?.count !== 1
    );
}

function hasBlockingStopSummary(record: TranscriptRecord): boolean {
  return record.type === "system" &&
    record.subtype === "stop_hook_summary" &&
    (
      record.preventedContinuation === true ||
      (Array.isArray(record.hookErrors) && record.hookErrors.length > 0)
    );
}

function hasTurnCompletionSignal(record: TranscriptRecord): boolean {
  if (
    record.type === "system" &&
    record.subtype === "turn_duration"
  ) {
    return true;
  }
  if (record.type !== "assistant" || !isRecord(record.message)) {
    return false;
  }
  return record.isApiErrorMessage === true ||
    (
      nonEmptyString(record.message.stop_reason) !== undefined &&
      record.message.stop_reason !== "tool_use"
    );
}

function structuredBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    if (typeof value[key] === "boolean") {
      return value[key] as boolean;
    }
  }
  return undefined;
}

function assertSupportedRecord(
  record: TranscriptRecord,
  sessionId: string,
  cwd?: string
): void {
  if (
    record.sessionId !== sessionId ||
    nonEmptyString(record.cwd) === undefined ||
    (cwd !== undefined && normalizePath(record.cwd) !== normalizePath(cwd)) ||
    record.isSidechain !== false ||
    record.entrypoint !== "cli" ||
    !isCompatibleClaudeVersion(record.version)
  ) {
    throw new Error("Claude transcript completion record uses an unsupported schema or identity");
  }
}

function isCompatibleClaudeVersion(value: unknown): boolean {
  const version = nonEmptyString(value);
  const match = version === undefined
    ? undefined
    : CLAUDE_TRANSCRIPT_VERSION_PATTERN.exec(version);
  if (!match) {
    return false;
  }
  const parsed = match.slice(1).map(Number);
  if (!parsed.every(Number.isSafeInteger)) {
    return false;
  }
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== MINIMUM_CLAUDE_TRANSCRIPT_VERSION[index]) {
      return parsed[index] > MINIMUM_CLAUDE_TRANSCRIPT_VERSION[index];
    }
  }
  return true;
}

function isCompatiblePendingApprovalClaudeVersion(value: unknown): boolean {
  const version = nonEmptyString(value);
  const match = version === undefined
    ? undefined
    : CLAUDE_TRANSCRIPT_VERSION_PATTERN.exec(version);
  if (!match) {
    return false;
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === MINIMUM_CLAUDE_TRANSCRIPT_VERSION[0] &&
    minor === MINIMUM_CLAUDE_TRANSCRIPT_VERSION[1] &&
    Number.isSafeInteger(patch) &&
    patch >= MINIMUM_CLAUDE_TRANSCRIPT_VERSION[2];
}

function assertSameClaudeVersion(...records: readonly TranscriptRecord[]): void {
  const versions = new Set(records.map((record) => nonEmptyString(record.version)));
  if (versions.size !== 1 || versions.has(undefined)) {
    throw new Error("Claude transcript turn changed schema versions while it was running");
  }
}

function exactInteractiveAgent(
  rows: readonly ClaudeAgentRow[],
  pid: number
): ClaudeAgentRow | undefined {
  const matches = rows.filter((row) =>
    row.pid === pid && (row.kind === undefined || row.kind === "interactive")
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function runtimePidFromContext(context: unknown): number | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  return positiveInteger(context.pid);
}

function expectedTranscriptRelativePath(sessionId: string, cwd: string): string {
  return path.join(
    cwd.replace(/[^A-Za-z0-9]/gu, "-"),
    `${sessionId}.jsonl`
  );
}

function projectsRootPath(claudeHome: string): string {
  return path.join(claudeHome, "projects");
}

function fileEndsWithNewline(fd: number, size: number): boolean {
  const buffer = Buffer.allocUnsafe(1);
  return fs.readSync(fd, buffer, 0, 1, size - 1) === 1 && buffer[0] === 0x0a;
}

function sameStableTranscriptFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function isRealDirectory(value: string): boolean {
  const stat = lstatOrUndefined(value);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function lstatOrUndefined(value: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertPrivateTranscriptFile(stat: fs.Stats): void {
  if (process.platform === "win32") {
    return;
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid.call(process)) {
    throw new Error("Claude transcript is not owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Claude transcript permissions are broader than owner-only");
  }
}

function safeErrorCode(value: unknown): string {
  const error = nonEmptyString(value);
  return error && /^[A-Za-z0-9_.:-]{1,80}$/u.test(error)
    ? error
    : "claude_api_error";
}

function exactRequestFingerprint(value: unknown): string | undefined {
  const text = String(value ?? "");
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function claudeTranscriptAnchorFingerprint(
  anchor: ClaudeTranscriptAnchor
): string {
  return sha256Hex(JSON.stringify({
    schema: "agent-knock-knock/claude-transcript-acceptance-anchor",
    version: 1,
    session_id: anchor.session_id,
    cwd: anchor.cwd,
    pid: anchor.pid,
    agent_started_at_ms: anchor.agent_started_at_ms,
    captured_at: anchor.captured_at,
    relative_path: anchor.relative_path,
    offset_bytes: anchor.offset_bytes,
    file_existed: anchor.file_existed,
    device: anchor.device ?? null,
    inode: anchor.inode ?? null
  }));
}

function exactPromptText(value: unknown): string | undefined {
  const text = String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/[\r\n]+$/u, "");
  return text.length > 0 ? text : undefined;
}

function transcriptFileId(sessionId: string, fileIdentity: string): string {
  return sha256Hex(`${sessionId}\0${fileIdentity}`).slice(0, 24);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRedactedText(value: string): string {
  return redactString(value).trim().slice(0, 4000);
}

function normalizePath(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text ? path.resolve(text) : undefined;
}

function validTimestampMs(value: unknown): number | undefined {
  const timestamp = nonEmptyString(value);
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decimalFileIdentity(value: string | undefined): value is string {
  return value !== undefined && /^(?:0|[1-9]\d*)$/u.test(value);
}

function uuidValue(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && CLAUDE_SESSION_ID_PATTERN.test(text) ? text : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

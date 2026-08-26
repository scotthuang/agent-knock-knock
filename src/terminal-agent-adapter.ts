import { createHash } from "node:crypto";
import { isExecutorKind, type ExecutorKind } from "./executors.js";
import type {
  TerminalControlCapability,
  TerminalControlRef
} from "./terminal-control-ref.js";

export type {
  TerminalControlCapability,
  TerminalControlRef
} from "./terminal-control-ref.js";

export type DiscoveryConfidence = "high" | "medium" | "low";

export interface TerminalProcessSnapshot {
  pid: number;
  ppid?: number;
  command: string;
  cwd?: string;
  elapsed?: string;
}

export interface ActiveTerminalProcess<ProcessKind extends string = string> extends TerminalProcessSnapshot {
  agent: ExecutorKind;
  kind: ProcessKind;
  sessionId?: string;
  confidence: DiscoveryConfidence;
  reason: string;
  terminalControl?: TerminalControlRef;
}

export type TerminalActivityState = "awaiting_approval" | "working" | "idle" | "unknown";

export interface TerminalActivityInspection {
  state: TerminalActivityState;
  reason: string;
}

export interface TerminalApprovalAction {
  /** Terminal approval always uses an exact, ordered tmux key sequence. */
  mode?: "keys";
  /** Exact ordered tmux key sequence to send after prompt revalidation. */
  keys: readonly string[];
  label: string;
  /** Opaque evidence identity for the current approval request, when available. */
  requestId?: string;
}

/**
 * Opaque authority derived from the exact, unredacted approval prompt region.
 *
 * The raw region must never be persisted or exposed. The profile identifies
 * the adapter-owned region grammar, while the digest keeps every
 * authorization-relevant character after only transport normalization.
 */
export interface TerminalApprovalPromptEvidence {
  profile: string;
  sha256: string;
}

const TERMINAL_APPROVAL_ANSI_ESCAPE_PATTERN =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu;

/**
 * Hash an adapter-verified prompt region without redaction or semantic
 * whitespace normalization. ANSI escapes and CRLF/CR line endings are
 * provider transport differences, so those alone are normalized.
 */
export function terminalApprovalPromptEvidence(
  profile: string,
  unredactedPromptRegion: string
): TerminalApprovalPromptEvidence {
  const normalizedRegion = normalizeTerminalApprovalPromptRegion(
    unredactedPromptRegion
  );
  return {
    profile,
    sha256: createHash("sha256").update(normalizedRegion).digest("hex")
  };
}

/** Normalize only terminal-provider representation differences. */
export function normalizeTerminalApprovalPromptRegion(value: string): string {
  return value
    .replace(TERMINAL_APPROVAL_ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/gu, "\n");
}

/**
 * Executor-local authority for deterministic approval policy evaluation.
 *
 * `command` may contain raw terminal-agent input and must never be copied into
 * callback metadata, persisted state, logs, or screen summaries. Callers may
 * expose only the bounded hashes and opaque identities alongside it.
 */
export interface TerminalApprovalPolicyEvidence {
  source: "claude_transcript";
  kind: "run_command";
  command: string;
  cwd: string;
  toolName: "Bash";
  requestId: string;
  commandSha256: string;
  evidenceFingerprint: string;
  metadata: Readonly<Record<string, string | number>>;
}

export type TerminalApprovalInspection =
  | {
      blocked: true;
      approvable: true;
      promptKind: string;
      command?: string;
      /** Adapter-verified working directory for this exact approval request, when available. */
      cwd?: string;
      /** Safe display name for the tool that requested permission. */
      toolName?: string;
      /** Redacted, bounded summary of the permission target; never the full tool input. */
      requestDetail?: string;
      /** Raw executor-local policy authority. Never serialize this object. */
      policyEvidence?: TerminalApprovalPolicyEvidence;
      /** Adapter-verified digest of the exact, unredacted live prompt region. */
      promptEvidence?: TerminalApprovalPromptEvidence;
      action: TerminalApprovalAction;
    }
  | {
      blocked: boolean;
      approvable: false;
      reason: string;
      promptKind?: string;
      command?: string;
      cwd?: string;
      toolName?: string;
      requestDetail?: string;
      action?: undefined;
    };

export interface TerminalCompletionEvidence {
  source: "screen" | "durable";
  outcome?: "success" | "failure";
  text: string;
  timestamp?: string;
  id?: string;
  confidence?: "high" | "medium" | "low" | "screen_only";
  metadata?: Record<string, unknown>;
}

export interface TerminalNativeIdentityFence {
  sessionId: string;
  processUuid: string;
  processBirth: string;
  rollout: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
}

export interface TerminalRuntimeIdentity {
  pid?: number;
  sessionId?: string;
  nativeSessionId?: string;
  nativeProcessUuid?: string;
  nativeProcessBirth?: string;
  /**
   * Modern Claude turns require an exact process-incarnation token in addition
   * to the native session id. A numeric PID can be reused and is not enough to
   * authorize terminal side effects by itself.
   */
  requireNativeProcessUuid?: boolean;
  /**
   * Native inspection of Claude requires the same unique interactive
   * `claude agents --json --all` row to remain idle at every bridge identity
   * fence. The process-incarnation timestamp is part of that exact row.
   */
  requireExactClaudeAgentRow?: boolean;
  nativeProcessStartedAt?: number;
  /** Exact Claude agents state permitted at this bridge phase. */
  exactClaudeAgentState?: "idle" | "status_dialog";
  /**
   * Current Codex turns require the exact open root rollout descriptor and
   * process-birth evidence. A session id by itself is not an incarnation
   * fence and cannot authorize terminal side effects.
   */
  requireNativeRolloutIdentity?: boolean;
  nativeRollout?: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  /**
   * Exact native thread that an unmaterialized managed binding is allowed to
   * acquire while a terminal submission is in flight. This is deliberately
   * narrower than allowing any session to appear between tmux's text and
   * Enter operations.
   */
  expectedNativeSessionId?: string;
  expectedEmptyNativeSession?: boolean;
  /**
   * Exact pre-materialization Codex rollout that may remain visible after a
   * native `/clear`. This exception is scoped to the in-process text/Enter
   * handoff; it is never persisted as the new logical thread's rollout.
   */
  allowedPreMaterializationNativeIdentity?: TerminalNativeIdentityFence;
  /** Other exact managed rollouts that may remain open in the same process. */
  allowedAdditionalNativeIdentities?: TerminalNativeIdentityFence[];
  cwd?: string;
  conversationId?: string;
  messageId?: string;
  terminalTarget?: string;
}

export interface TerminalScreenInspectionOptions {
  screen: string;
  requestText?: string;
  screenChangedSinceSend?: boolean;
  maxExcerptLength?: number;
  runtime?: TerminalRuntimeIdentity;
  /** Managed-turn identity and transcript boundary used for local approval evidence. */
  managedRequest?: TerminalDurableCompletionRequest;
}

export interface TerminalScreenInspection {
  activity: TerminalActivityInspection;
  approval: TerminalApprovalInspection;
  screenExcerpt: string;
  completion?: TerminalCompletionEvidence;
}

export interface TerminalDurableCompletionRequest {
  sessionId?: string;
  cwd?: string;
  requestText?: string;
  requestHash?: string;
  startedAt?: string;
  context?: unknown;
}

export interface TerminalAgentAdapterCapabilities {
  processDiscovery: boolean;
  screenStatus: boolean;
  terminalApproval: boolean;
  screenCompletion: boolean;
  durableCompletion: boolean;
  cancellation: boolean;
}

export interface TerminalThreadLifecycleCapabilities {
  status: "supported" | "unsupported" | "unknown";
  agentVersion?: string;
  /** Adapter behavior profile selected for the observed version. */
  behaviorProfile?: string;
  /** Whether this exact version has been regression-tested by AKK. */
  versionCompatibility?: "verified" | "unverified";
  /** Diagnostic only: an unverified version never vetoes an otherwise valid action. */
  compatibilityWarning?: string;
  newThread: boolean;
  resumeExact: boolean;
  /** Candidate discovery is exposed only when identity metadata can be revalidated. */
  candidateDiscovery?: boolean;
  reason: string;
}

export type TerminalThreadLifecycleOperation =
  | { kind: "new_thread" }
  | { kind: "resume_thread"; nativeThreadId: string };

export type TerminalThreadLifecycleStepKind =
  | "identity_probe_before"
  | "transition"
  | "identity_probe_after";

export interface TerminalThreadLifecycleStep {
  kind: TerminalThreadLifecycleStepKind;
  command: string;
  effect: "read_only" | "thread_transition";
  /** Every lifecycle command is dispatched only from a verified idle composer. */
  requiresIdle: true;
}

export interface TerminalThreadLifecyclePlan {
  operation: TerminalThreadLifecycleOperation;
  /** Exact adapter behavior profile that authorized these commands. */
  behaviorProfile: string;
  /** Ordered, closed command set. Callers must not synthesize extra slash commands. */
  steps: readonly TerminalThreadLifecycleStep[];
  /** @deprecated Use the step whose kind is `transition`. */
  command: string;
  /** @deprecated Use the step whose kind is `identity_probe_after`. */
  identityProbeCommand?: string;
  expectedResult:
    | { kind: "different_native_thread" }
    | { kind: "exact_native_thread"; nativeThreadId: string };
}

export interface TerminalThreadLifecycleAgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  startedAt?: number;
  status?: string;
}

export interface TerminalThreadLifecycleObservationRequest {
  operation: TerminalThreadLifecycleOperation;
  phase: "before" | "after";
  screen?: string;
  beforeNativeThreadId?: string;
  expectedNativeThreadId?: string;
  pid?: number;
  processStartedAt?: number;
  cwd?: string;
  agentRows?: readonly TerminalThreadLifecycleAgentRow[];
}

export interface TerminalThreadLifecycleObservation {
  status: "observed" | "verified" | "missing" | "ambiguous" | "mismatch";
  nativeThreadId?: string;
  evidence?: string;
  idle?: boolean;
  reason?: string;
}

export interface TerminalThreadLifecycleObserver {
  (request: TerminalThreadLifecycleObservationRequest): TerminalThreadLifecycleObservation;
  /** @deprecated Pass a typed observation request. */
  (
    screen: string,
    operation: TerminalThreadLifecycleOperation
  ): TerminalThreadLifecycleObservation;
}

/**
 * A closed, adapter-owned native inspection operation.
 *
 * Callers select a semantic inspection kind; they never supply the native
 * slash command that implements it.
 */
export type TerminalNativeInspectionOperation = { kind: "status" };

export interface TerminalNativeInspectionCapabilities {
  status: "supported" | "unsupported" | "unknown";
  agentVersion?: string;
  /** Adapter behavior profile selected for the observed version. */
  behaviorProfile?: string;
  /** Whether this exact version has been regression-tested by AKK. */
  versionCompatibility?: "verified" | "unverified";
  /** Diagnostic only: an unverified version never vetoes an otherwise valid action. */
  compatibilityWarning?: string;
  statusInspection: boolean;
  reason: string;
}

export interface TerminalNativeInspectionPlan {
  operation: TerminalNativeInspectionOperation;
  /** Exact adapter behavior profile that authorized this command. */
  behaviorProfile: string;
  /** Closed adapter-owned command. Callers must not substitute arbitrary input. */
  command: string;
  effect: "read_only";
  requiresIdle: true;
  /** Exact composer materialization required before the one Enter dispatch. */
  composer: {
    kind: "exact";
    minimumStableMs: number;
    /** Version-profiled upper bound for exact composer materialization. */
    maximumSettleMs: number;
  };
  expectedResult: {
    kind: "native_status";
    /** Inline cards remain at the prompt; modal panels must be dismissed. */
    presentation: "inline" | "modal";
    /** Closed adapter-owned dismissal sequence for a verified modal result. */
    dismissal?: {
      keys: readonly string[];
      expected: "idle_empty_composer";
    };
  };
}

export interface TerminalNativeInspectionField {
  name: string;
  value: string;
}

export interface TerminalNativeStatusInspectionResult {
  kind: "native_status";
  nativeThreadId: string;
  /** Agent version rendered by the native status surface itself. */
  agentVersion: string;
  /** Bounded, redacted fields parsed from the native status surface. */
  fields: readonly TerminalNativeInspectionField[];
  /** Bounded, redacted display summary. Never raw terminal scrollback. */
  excerpt: string;
}

/**
 * Bounded pre/post inventory for exact native inspection result evidence.
 * Counts let a byte-identical newly rendered card remain distinguishable from
 * a pre-existing card without exposing its terminal contents.
 */
export interface TerminalNativeInspectionEvidenceInventoryEntry {
  evidenceFingerprint: string;
  occurrenceCount: number;
}

export interface TerminalNativeInspectionObservationRequest {
  operation: TerminalNativeInspectionOperation;
  screen?: string;
  /**
   * Fingerprint of the exact screen observed immediately before Enter.
   * Supplying it makes unchanged output fail closed as stale.
   */
  previousScreenFingerprint?: string;
  /**
   * Complete exact result evidence visible immediately before Enter. A post
   * result is fresh only when its fingerprint occurrence strictly increases.
   */
  preEnterEvidenceInventory?: readonly TerminalNativeInspectionEvidenceInventoryEntry[];
  /** Optional exact binding identity that the status surface must confirm. */
  expectedNativeThreadId?: string;
  /** Optional exact running version that the status surface must confirm. */
  expectedAgentVersion?: string;
  /** Optional exact working directory that the status surface must confirm. */
  expectedCwd?: string;
}

export interface TerminalNativeInspectionObservation {
  status: "observed" | "missing" | "ambiguous" | "stale" | "mismatch";
  nativeThreadId?: string;
  observedAgentVersion?: string;
  evidence?: string;
  /** Fingerprint of the bounded native result region. */
  evidenceFingerprint?: string;
  /** Fingerprint callers can bind to a later fresh observation. */
  screenFingerprint: string;
  /** Bounded hashes/counts only; never raw native result text. */
  evidenceInventory?: readonly TerminalNativeInspectionEvidenceInventoryEntry[];
  result?: TerminalNativeStatusInspectionResult;
  reason?: string;
}

export interface TerminalNativeInspectionObserver {
  (request: TerminalNativeInspectionObservationRequest): TerminalNativeInspectionObservation;
}

export interface TerminalThreadFileToken {
  path: string;
  device: string;
  inode: string;
  size: number;
  mtimeMs: number;
}

interface TerminalThreadLifecycleCandidateTokenBase {
  schema: "agent-knock-knock/thread-candidate-token";
  agent: ExecutorKind;
  nativeThreadId: string;
  cwd: string;
  source: "codex_rollout" | "claude_transcript";
  /** Exact running adapter version that authorizes lifecycle terminal behavior. */
  agentVersion: string;
  fileToken: TerminalThreadFileToken;
  metadataFingerprint: string;
  modelProvider?: string;
}

/** Existing same-version token semantics, retained byte-for-byte for compatibility. */
export interface TerminalThreadLifecycleCandidateTokenV1
  extends TerminalThreadLifecycleCandidateTokenBase {
  version: 1;
  sourceAgentVersion?: never;
}

/**
 * Token for a persisted thread created by an agent version other than the
 * currently running adapter version.
 */
export interface TerminalThreadLifecycleCandidateTokenV2
  extends TerminalThreadLifecycleCandidateTokenBase {
  version: 2;
  /** Historical agent version that created the candidate's persisted source. */
  sourceAgentVersion: string;
}

export type TerminalThreadLifecycleCandidateToken =
  | TerminalThreadLifecycleCandidateTokenV1
  | TerminalThreadLifecycleCandidateTokenV2;

export interface TerminalThreadLifecycleCandidate {
  agent: ExecutorKind;
  nativeThreadId: string;
  cwd: string;
  source: "codex_rollout" | "claude_transcript";
  rootInteractive: true;
  fileToken: TerminalThreadFileToken;
  /** Exact running adapter version that authorizes lifecycle terminal behavior. */
  agentVersion: string;
  /** Historical source version; required for cross-version lifecycle candidates. */
  sourceAgentVersion?: string;
  title?: string;
  preview?: string;
  updatedAtMs?: number;
  modelProvider?: string;
  metadataFingerprint: string;
  /** Opaque, JSON-safe identity that must be revalidated under the terminal lock. */
  candidateToken: TerminalThreadLifecycleCandidateToken;
}

export interface TerminalThreadLifecycleCandidateRequest {
  cwd: string;
  agentVersion: string;
  modelProvider?: string;
}

export interface TerminalThreadLifecycleCandidateValidation {
  status: "valid" | "changed" | "unavailable" | "unsafe";
  candidate?: TerminalThreadLifecycleCandidate;
  reason?: string;
}

export interface TerminalThreadLifecycleCandidateProvider {
  listThreadLifecycleCandidates(
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<readonly TerminalThreadLifecycleCandidate[]>;
  revalidateThreadLifecycleCandidate(
    candidate: TerminalThreadLifecycleCandidate | TerminalThreadLifecycleCandidateToken,
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<TerminalThreadLifecycleCandidateValidation>;
}

export interface TerminalAgentAdapter<ProcessKind extends string = string> {
  readonly agent: ExecutorKind;
  readonly displayName: string;
  readonly capabilities: Readonly<TerminalAgentAdapterCapabilities>;
  /** Exact ordered tmux key sequence used to cancel the interactive agent. */
  readonly cancelKeys: readonly string[];

  classifyProcess(snapshot: TerminalProcessSnapshot): ActiveTerminalProcess<ProcessKind> | undefined;
  inspectScreen(options: TerminalScreenInspectionOptions): TerminalScreenInspection;
  detectDurableCompletion?(
    request: TerminalDurableCompletionRequest
  ): Promise<TerminalCompletionEvidence | undefined>;
  probeThreadLifecycle?(
    agentVersion: string | undefined
  ): TerminalThreadLifecycleCapabilities;
  planThreadLifecycle?(
    operation: TerminalThreadLifecycleOperation,
    capabilities: TerminalThreadLifecycleCapabilities
  ): TerminalThreadLifecyclePlan;
  observeThreadLifecycle?: TerminalThreadLifecycleObserver;
  probeNativeInspection?(
    agentVersion: string | undefined
  ): TerminalNativeInspectionCapabilities;
  planNativeInspection?(
    operation: TerminalNativeInspectionOperation,
    capabilities: TerminalNativeInspectionCapabilities
  ): TerminalNativeInspectionPlan;
  observeNativeInspection?: TerminalNativeInspectionObserver;
  listThreadLifecycleCandidates?(
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<readonly TerminalThreadLifecycleCandidate[]>;
  revalidateThreadLifecycleCandidate?(
    candidate: TerminalThreadLifecycleCandidate | TerminalThreadLifecycleCandidateToken,
    request: TerminalThreadLifecycleCandidateRequest
  ): Promise<TerminalThreadLifecycleCandidateValidation>;
}

export class TerminalAgentAdapterRegistry {
  private readonly adapters = new Map<ExecutorKind, TerminalAgentAdapter>();

  constructor(adapters: readonly TerminalAgentAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: TerminalAgentAdapter): this {
    if (this.adapters.has(adapter.agent)) {
      throw new Error(`terminal agent adapter is already registered for ${adapter.agent}`);
    }
    if (adapter.capabilities.durableCompletion && !adapter.detectDurableCompletion) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} advertises durable completion without implementing it`
      );
    }
    if (adapter.capabilities.cancellation && adapter.cancelKeys.length === 0) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} advertises cancellation without an ordered key sequence`
      );
    }
    const lifecycleMethodCount = [
      adapter.probeThreadLifecycle,
      adapter.planThreadLifecycle,
      adapter.observeThreadLifecycle
    ].filter((method) => method !== undefined).length;
    if (lifecycleMethodCount !== 0 && lifecycleMethodCount !== 3) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} must implement lifecycle probe, plan, and observer methods together`
      );
    }
    const nativeInspectionMethodCount = [
      adapter.probeNativeInspection,
      adapter.planNativeInspection,
      adapter.observeNativeInspection
    ].filter((method) => method !== undefined).length;
    if (nativeInspectionMethodCount !== 0 && nativeInspectionMethodCount !== 3) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} must implement native inspection probe, plan, and observer methods together`
      );
    }
    if (
      (adapter.listThreadLifecycleCandidates === undefined) !==
      (adapter.revalidateThreadLifecycleCandidate === undefined)
    ) {
      throw new Error(
        `terminal agent adapter ${adapter.agent} must implement lifecycle candidate listing and revalidation together`
      );
    }
    this.adapters.set(adapter.agent, adapter);
    return this;
  }

  get(agent: ExecutorKind | string): TerminalAgentAdapter | undefined {
    return isExecutorKind(agent) ? this.adapters.get(agent) : undefined;
  }

  require(agent: ExecutorKind | string): TerminalAgentAdapter {
    const adapter = this.get(agent);
    if (!adapter) {
      throw new Error(`terminal agent adapter is not registered for ${agent || "<empty>"}`);
    }
    return adapter;
  }

  list(): TerminalAgentAdapter[] {
    return [...this.adapters.values()];
  }
}

export function createTerminalAgentAdapterRegistry(
  adapters: readonly TerminalAgentAdapter[] = []
): TerminalAgentAdapterRegistry {
  return new TerminalAgentAdapterRegistry(adapters);
}

export function terminalControlCapabilitiesForAdapter(
  adapter: Pick<TerminalAgentAdapter, "capabilities">
): TerminalControlCapability[] {
  const capabilities: TerminalControlCapability[] = [];
  if (adapter.capabilities.screenStatus) {
    capabilities.push("screen_status");
  }
  capabilities.push("send_keys");
  if (adapter.capabilities.terminalApproval) {
    capabilities.push("terminal_approval");
  }
  if (adapter.capabilities.screenCompletion) {
    capabilities.push("screen_completion");
  }
  if (adapter.capabilities.durableCompletion) {
    capabilities.push("durable_completion");
  }
  if (adapter.capabilities.cancellation) {
    capabilities.push("terminal_cancel");
  }
  return capabilities;
}

export interface TerminalConversationIdentity {
  conversationId: string;
  kind: "tmux" | "herdr";
  agent: ExecutorKind;
  target: string;
  pid: number;
  legacy: boolean;
}

export function formatTerminalConversationId({
  agent,
  target,
  pid,
  kind = "tmux"
}: {
  agent: ExecutorKind;
  target: string;
  pid: number;
  kind?: "tmux" | "herdr";
}): string {
  if (!isExecutorKind(agent)) {
    throw new Error(`unsupported terminal agent: ${String(agent || "<empty>")}`);
  }
  if (!(kind === "tmux" || kind === "herdr")) {
    throw new Error(`unsupported terminal provider: ${String(kind || "<empty>")}`);
  }
  assertTerminalIdentityParts(target, pid);
  return `terminal:v2:${kind}:${agent}:${target}:${pid}`;
}

export function parseTerminalConversationId(
  conversationId: string | undefined
): TerminalConversationIdentity | undefined {
  const legacyPrefix = "terminal:tmux:";
  const match = /^terminal:v2:(tmux|herdr):/u.exec(conversationId ?? "");
  if (!conversationId || (!match && !conversationId.startsWith(legacyPrefix))) {
    return undefined;
  }

  const legacy = conversationId.startsWith(legacyPrefix);
  const kind = legacy ? "tmux" : match?.[1] as "tmux" | "herdr";
  const prefix = legacy ? legacyPrefix : `terminal:v2:${kind}:`;
  const rest = conversationId.slice(prefix.length);
  const pidSeparator = rest.lastIndexOf(":");
  if (pidSeparator <= 0 || pidSeparator === rest.length - 1) {
    throw new Error(`invalid terminal-controlled conversation id: ${conversationId}`);
  }
  let identity = rest.slice(0, pidSeparator);
  const pid = Number(rest.slice(pidSeparator + 1));
  let agent: ExecutorKind = "codex";
  if (!legacy) {
    const agentSeparator = identity.indexOf(":");
    const parsedAgent = agentSeparator > 0 ? identity.slice(0, agentSeparator) : "";
    if (!isExecutorKind(parsedAgent)) {
      throw new Error(
        `unsupported terminal agent in conversation id: ${parsedAgent || "<empty>"}`
      );
    }
    agent = parsedAgent;
    identity = identity.slice(agentSeparator + 1);
  }
  const target = identity;
  assertTerminalIdentityParts(target, pid, conversationId);

  return {
    conversationId,
    kind,
    agent,
    target,
    pid,
    legacy
  };
}

function assertTerminalIdentityParts(target: string, pid: number, conversationId?: string): void {
  if (!target || !Number.isInteger(pid)) {
    throw new Error(
      conversationId
        ? `invalid terminal-controlled conversation id: ${conversationId}`
        : "terminal-controlled conversation id requires a target and integer pid"
    );
  }
}

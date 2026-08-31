import path from "node:path";
import type {
  TerminalNativeIdentityFence,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleAgentRow,
  TerminalThreadLifecycleCapabilities,
  TerminalThreadLifecycleCandidateToken,
  TerminalThreadLifecycleOperation,
  TerminalThreadLifecyclePlan
} from "./terminal-agent-adapter.js";
import {
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  type ResolvedTerminalConversation,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import {
  isCompleteNativeRollout,
  terminalNativeIdentityFence as nativeThreadIdentityFence,
  terminalNativeIdentityMatchesFence as nativeThreadIdentityMatchesFence,
  type TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import {
  isExactNativeThreadId,
  type ManagedSessionState,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  classifyCodexLifecyclePostcondition,
  isFreshCodexPostProbeScreen
} from "./native-thread-lifecycle-policy.js";
import { decideNativeThreadTransitionEligibility } from "./native-thread-transition-policy.js";
import type {
  NativeThreadVerificationRequest
} from "./native-thread-transition-settlement-service.js";
import { nonBlankString } from "./value-guards.js";

export {
  nativeThreadIdentityFence,
  nativeThreadIdentityMatchesFence
};

export type NativeThreadVerificationAdapterPorts = Readonly<{
  createBridge: () => TerminalAgentBridge;
  loadClaudeAgentRows: () => readonly TerminalThreadLifecycleAgentRow[];
  runningVersion: () => string | undefined;
  runtimeForIdentity: (
    identity: TerminalNativeIdentity
  ) => TerminalRuntimeIdentity;
  emptyRuntime: () => TerminalRuntimeIdentity;
  physicalRuntime: () => TerminalRuntimeIdentity;
  resolveIdentity: (
    preferredSessionId: string,
    allowedCompanionIdentity: TerminalNativeIdentityFence | undefined,
    allowedAdditionalIdentities: readonly TerminalNativeIdentityFence[]
  ) => Promise<TerminalNativeIdentity | undefined>;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export type NativeThreadVerificationPreparationRequest = Readonly<{
  operation: TerminalThreadLifecycleOperation;
  expectedBindingToken: string;
  bindingTokens: readonly string[];
  capabilities: TerminalThreadLifecycleCapabilities;
  beforeIdentity?: TerminalNativeIdentity;
  physicalBeforeIdentity?: TerminalNativeIdentity;
  allowedCompanionIdentity?: TerminalNativeIdentityFence;
  allowedAdditionalIdentities?: readonly TerminalNativeIdentityFence[];
}>;

export type NativeThreadVerificationPreparationPorts =
  NativeThreadVerificationAdapterPorts & Readonly<{
    plan: () => TerminalThreadLifecyclePlan | undefined;
    assertReady: (status: TerminalBridgeStatus) => void;
    revalidateSelectionSnapshot?: () => Promise<void>;
    finalizeIdentity: (
      identity: TerminalNativeIdentity
    ) => TerminalNativeIdentity;
  }>;

export type PreparedNativeThreadVerification = Readonly<{
  bridge: TerminalAgentBridge;
  plan: TerminalThreadLifecyclePlan;
  beforeIdentity: TerminalNativeIdentity;
  beforeRuntime: TerminalRuntimeIdentity;
  initialScreenDigest?: string;
}>;

export type NativeThreadCompanionSet = Readonly<{
  primary?: TerminalNativeIdentityFence;
  additional: TerminalNativeIdentityFence[];
}>;

// Resuming a Codex thread can restart configured MCP servers. Codex 0.151.0
// keeps the composer visible while that bounded startup is still in progress,
// so the broad activity classifier can report idle before the exact composer
// is safe for the post-transition /status probe. Keep polling without input
// when the probe proves it did not start, allowing the default 30-second MCP
// startup timeout plus repaint margin.
const DEFAULT_POST_TRANSITION_SETTLE_ATTEMPTS = 100;
const CODEX_MCP_POST_TRANSITION_SETTLE_ATTEMPTS = 400;

function postTransitionSettleAttempts(
  terminal: Pick<ResolvedTerminalConversation, "agent">,
  plan: Pick<TerminalThreadLifecyclePlan, "behaviorProfile">
): number {
  if (terminal.agent !== "codex") {
    return DEFAULT_POST_TRANSITION_SETTLE_ATTEMPTS;
  }
  return ["codex-tui-0.151.0", "codex-tui-generic-v1"].includes(
    plan.behaviorProfile
  )
    ? CODEX_MCP_POST_TRANSITION_SETTLE_ATTEMPTS
    : DEFAULT_POST_TRANSITION_SETTLE_ATTEMPTS;
}

export function nativeThreadRuntimeWithCompanionFences(
  runtime: TerminalRuntimeIdentity,
  companions: NativeThreadCompanionSet
): TerminalRuntimeIdentity {
  return {
    ...runtime,
    allowedPreMaterializationNativeIdentity:
      companions.primary,
    allowedAdditionalNativeIdentities:
      [...companions.additional]
  };
}

function codexBeforeRuntime(
  request: NativeThreadVerificationPreparationRequest,
  identity: TerminalNativeIdentity | undefined,
  ports: NativeThreadVerificationAdapterPorts
): TerminalRuntimeIdentity {
  const exactPhysicalIdentity =
    request.physicalBeforeIdentity?.sessionId === identity?.sessionId
      ? request.physicalBeforeIdentity
      : undefined;
  const runtime = exactPhysicalIdentity
    ? ports.runtimeForIdentity(exactPhysicalIdentity)
    : {
        ...ports.emptyRuntime(),
        ...(identity?.processUuid
          ? { nativeProcessUuid: identity.processUuid }
          : {}),
        ...(identity?.processBirth
          ? { nativeProcessBirth: identity.processBirth }
          : {}),
        expectedNativeSessionId: identity?.sessionId
      };
  return nativeThreadRuntimeWithCompanionFences(runtime, {
    primary: request.allowedCompanionIdentity,
    additional: [...(request.allowedAdditionalIdentities ?? [])]
  });
}

function assertVerifiedClaudeBeforeObservation(
  request: NativeThreadVerificationPreparationRequest,
  terminal: ResolvedTerminalConversation,
  ports: NativeThreadVerificationAdapterPorts
): void {
  if (terminal.agent !== "claude") return;
  if (!terminal.terminalControl.currentPath) {
    throw new Error(
      "Claude lifecycle control requires an exact terminal working directory"
    );
  }
  const observed = terminal.adapter.observeThreadLifecycle?.({
    operation: request.operation,
    phase: "before",
    pid: terminal.pid,
    processStartedAt: request.beforeIdentity?.processStartedAt,
    cwd: terminal.terminalControl.currentPath,
    agentRows: ports.loadClaudeAgentRows()
  });
  if (
    observed?.status !== "observed" ||
    !isExactNativeThreadId(request.beforeIdentity?.sessionId) ||
    observed.nativeThreadId !== request.beforeIdentity.sessionId.toLowerCase() ||
    observed.idle !== true
  ) {
    throw new Error(
      "Claude lifecycle control requires one exact idle interactive agents row " +
      `for the current process incarnation${
        observed?.reason ? `: ${observed.reason}` : ""
      }`
    );
  }
}

export async function probeCodexCurrentThread(
  request: Readonly<{
    terminal: ResolvedTerminalConversation;
    currentIdentity?: TerminalNativeIdentity;
    runtimeIdentity?: TerminalNativeIdentity;
    runtimeOverride?: TerminalRuntimeIdentity;
  }>,
  ports: NativeThreadVerificationAdapterPorts
): Promise<TerminalNativeIdentity> {
  const { terminal } = request;
  if (terminal.agent !== "codex") {
    throw new Error("the current native thread identity is unavailable");
  }
  const bridge = ports.createBridge();
  const probeRuntime = request.runtimeOverride ??
    (request.runtimeIdentity
      ? ports.runtimeForIdentity(request.runtimeIdentity)
      : ports.emptyRuntime());
  const agentVersion = ports.runningVersion();
  if (!agentVersion) {
    throw new Error(
      "Codex /status requires the exact running version before terminal input"
    );
  }
  const submission = await bridge.submitCodexStatusProbe(
    terminal.terminalControl,
    agentVersion,
    { runtime: probeRuntime }
  );
  let lastObservationReason =
    "no fresh idle Codex /status card was captured after the one Enter dispatch";
  let sawIncompleteSessionUuid = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await bridge.status(
      terminal.agent,
      terminal.terminalControl,
      {
        runtime: probeRuntime,
        scrollbackLines: submission.observationScrollbackLines
      }
    );
    if (
      status.reachable &&
      status.screen.digest !== submission.observationBaselineDigest
    ) {
      const observed = terminal.adapter.observeThreadLifecycle?.({
        operation: { kind: "new_thread" },
        phase: "before",
        screen: status.screen.excerpt ?? ""
      });
      lastObservationReason = observed?.reason ?? lastObservationReason;
      sawIncompleteSessionUuid ||= observed?.status === "missing" &&
        /complete Session UUID/iu.test(observed.reason ?? "");
      if (
        observed?.status === "observed" &&
        observed.nativeThreadId &&
        status.activity_state === "idle"
      ) {
        return {
          sessionId: observed.nativeThreadId,
          processUuid:
            request.currentIdentity?.processUuid ??
            request.runtimeIdentity?.processUuid,
          processBirth:
            request.currentIdentity?.processBirth ??
            request.runtimeIdentity?.processBirth,
          rollout:
            request.currentIdentity?.sessionId === observed.nativeThreadId
              ? request.currentIdentity.rollout
              : undefined,
          evidence: observed.evidence ?? "codex_status_card"
        };
      }
    }
    await ports.sleep(100);
  }
  throw new Error(
    sawIncompleteSessionUuid
      ? "Codex /status Enter was dispatched exactly once, but the status card " +
        "was truncated before the complete current Session UUID; widen or zoom " +
        "the pane, refresh AKK list, and do not retry the probe automatically"
      : "Codex /status Enter was dispatched exactly once, but no fresh exact " +
        `current Session UUID was proven; do not retry automatically: ${lastObservationReason}`
  );
}

export async function prepareNativeThreadVerification(
  request: NativeThreadVerificationPreparationRequest,
  terminal: ResolvedTerminalConversation,
  ports: NativeThreadVerificationPreparationPorts
): Promise<PreparedNativeThreadVerification> {
  const eligibility = decideNativeThreadTransitionEligibility({
    operation: request.operation.kind,
    bindingTokenMatches:
      request.bindingTokens.includes(request.expectedBindingToken),
    capabilityStatus: request.capabilities.status,
    newThreadSupported: request.capabilities.newThread,
    resumeExactSupported: request.capabilities.resumeExact
  });
  if (eligibility.action === "reject") {
    throw new Error(
      eligibility.reason === "binding_token_changed"
        ? "terminal binding changed after it was listed; refresh AKK list and retry"
        : request.capabilities.reason
    );
  }
  if (ports.revalidateSelectionSnapshot) {
    await ports.revalidateSelectionSnapshot();
  }
  const plan = ports.plan();
  if (!plan) {
    throw new Error("the agent adapter did not produce a lifecycle plan");
  }
  const bridge = ports.createBridge();
  let beforeIdentity = request.beforeIdentity;
  let beforeRuntime = terminal.agent === "codex"
    ? codexBeforeRuntime(request, beforeIdentity, ports)
    : request.physicalBeforeIdentity
      ? ports.runtimeForIdentity(request.physicalBeforeIdentity)
      : ports.emptyRuntime();
  const terminalStatus = await bridge.status(
    terminal.agent,
    terminal.terminalControl,
    { runtime: beforeRuntime }
  );
  ports.assertReady(terminalStatus);
  assertVerifiedClaudeBeforeObservation(request, terminal, ports);
  if (terminal.agent === "codex") {
    const statusIdentity = await probeCodexCurrentThread({
      terminal,
      currentIdentity: beforeIdentity,
      runtimeIdentity: request.physicalBeforeIdentity,
      runtimeOverride: beforeRuntime
    }, ports);
    if (
      beforeIdentity &&
      beforeIdentity.sessionId !== statusIdentity.sessionId
    ) {
      throw new Error(
        "Codex /status disagrees with the open rollout identity before /clear"
      );
    }
    beforeIdentity = {
      ...beforeIdentity,
      ...statusIdentity,
      evidence: beforeIdentity
        ? `${beforeIdentity.evidence}+codex_status_card`
        : statusIdentity.evidence
    };
    beforeRuntime = codexBeforeRuntime(request, beforeIdentity, ports);
  }
  if (!isExactNativeThreadId(beforeIdentity?.sessionId)) {
    throw new Error(
      "native thread lifecycle requires an exact before-thread UUID"
    );
  }
  return {
    bridge,
    plan,
    beforeIdentity: ports.finalizeIdentity(beforeIdentity),
    beforeRuntime,
    initialScreenDigest: terminalStatus.screen.digest
  };
}

function sameFilesystemDevice(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return left === right;
  }
}

export function nativeThreadCandidateFileIdentity(
  token: TerminalThreadLifecycleCandidateToken | undefined
): NativeThreadTransition["target_candidate_file_identity"] {
  if (!token || token.agent !== "codex" || token.source !== "codex_rollout") {
    return undefined;
  }
  return {
    path: path.resolve(token.fileToken.path),
    device: token.fileToken.device,
    inode: token.fileToken.inode
  };
}

export function assertResumedNativeThreadMatchesCandidate(
  identity: TerminalNativeIdentity,
  expected: NativeThreadTransition["target_candidate_file_identity"]
): void {
  if (!expected) {
    throw new Error("Codex resume is missing its revalidated rollout token");
  }
  const rollout = identity.rollout;
  if (
    !isCompleteNativeRollout(rollout) ||
    !nonBlankString(expected.path) ||
    !nonBlankString(expected.device) ||
    !nonBlankString(expected.inode) ||
    path.resolve(rollout.path) !== path.resolve(expected.path) ||
    !sameFilesystemDevice(rollout.device, expected.device) ||
    rollout.inode !== expected.inode
  ) {
    throw new Error(
      "the resumed Codex rollout does not match the revalidated candidate file identity"
    );
  }
}

export function knownNativeThreadCompanionSet(
  input: Readonly<{
    terminal: Pick<
      ResolvedTerminalConversation,
      "conversationId" | "pid" | "terminalControl"
    >;
    transition: NativeThreadTransition;
    managedSessions: readonly ManagedSessionState[];
  }>,
  ports: Readonly<{
    terminalAliasMatches: (
      storedTerminalId: unknown,
      storedControl: unknown,
      currentTerminalId: unknown,
      currentControl: unknown
    ) => boolean;
    workspaceMatches: (left: unknown, right: unknown) => boolean;
  }>
): NativeThreadCompanionSet {
  const { terminal, transition } = input;
  const candidates: TerminalNativeIdentityFence[] = [];
  if (
    transition.before_process_uuid &&
    transition.before_process_birth &&
    isCompleteNativeRollout(transition.before_process_rollout)
  ) {
    candidates.push({
      sessionId: transition.before_native_thread_id,
      processUuid: transition.before_process_uuid,
      processBirth: transition.before_process_birth,
      rollout: transition.before_process_rollout
    });
  }
  const after = transition.after_binding;
  if (
    after?.native_thread_id &&
    after.native_process.process_uuid &&
    after.native_process.process_birth &&
    after.native_process.pid === terminal.pid &&
    ports.terminalAliasMatches(
      after.terminal_id,
      after.terminal_control,
      terminal.conversationId,
      terminal.terminalControl
    ) &&
    after.native_process.process_uuid === transition.before_process_uuid &&
    after.native_process.process_birth === transition.before_process_birth &&
    isCompleteNativeRollout(after.native_process.rollout)
  ) {
    candidates.push({
      sessionId: after.native_thread_id,
      processUuid: after.native_process.process_uuid,
      processBirth: after.native_process.process_birth,
      rollout: after.native_process.rollout
    });
  }
  for (const session of input.managedSessions) {
    const binding = session.binding;
    if (
      session.agent !== "codex" ||
      session.status !== "detached" ||
      !binding?.native_thread_id ||
      !binding.native_process.process_uuid ||
      !binding.native_process.process_birth ||
      binding.native_process.pid !== terminal.pid ||
      binding.native_process.process_uuid !== transition.before_process_uuid ||
      binding.native_process.process_birth !== transition.before_process_birth ||
      !ports.terminalAliasMatches(
        binding.terminal_id,
        binding.terminal_control,
        terminal.conversationId,
        terminal.terminalControl
      ) ||
      !ports.workspaceMatches(transition.workspace, session.workspace) ||
      !isCompleteNativeRollout(binding.native_process.rollout)
    ) {
      continue;
    }
    candidates.push({
      sessionId: binding.native_thread_id,
      processUuid: binding.native_process.process_uuid,
      processBirth: binding.native_process.process_birth,
      rollout: binding.native_process.rollout
    });
  }
  const seen = new Set<string>();
  const exact = candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { primary: exact[0], additional: exact.slice(1) };
}

function beforeFences(
  request: NativeThreadVerificationRequest
): TerminalNativeIdentityFence[] {
  const candidates = [
    nativeThreadIdentityFence(request.physicalBeforeIdentity),
    nativeThreadIdentityFence(request.beforeIdentity),
    request.allowedCompanionIdentity,
    ...(request.allowedAdditionalIdentities ?? [])
  ];
  const unique: TerminalNativeIdentityFence[] = [];
  for (const candidate of candidates) {
    if (
      candidate &&
      !unique.some((value) =>
        nativeThreadIdentityMatchesFence(value, candidate)
      )
    ) {
      unique.push(candidate);
    }
  }
  return unique;
}

function sameStableIdentity(
  left: TerminalNativeIdentity | undefined,
  right: TerminalNativeIdentity
): boolean {
  return left?.sessionId === right.sessionId &&
    left.processUuid === right.processUuid &&
    left.processBirth === right.processBirth &&
    left.rollout?.fd === right.rollout?.fd &&
    left.rollout?.device === right.rollout?.device &&
    left.rollout?.inode === right.rollout?.inode &&
    left.rollout?.path === right.rollout?.path;
}

export async function verifyNativeThreadTransition(
  request: NativeThreadVerificationRequest,
  terminal: ResolvedTerminalConversation,
  ports: NativeThreadVerificationAdapterPorts
): Promise<TerminalNativeIdentity> {
  const bridge = ports.createBridge();
  const exactBeforeRoots = beforeFences(request);
  let probeSent = false;
  let postProbeBaselineDigest: string | undefined;
  let observationScrollbackLines: number | undefined;
  let stableIdentity: TerminalNativeIdentity | undefined;
  let stableCount = 0;
  const settleAttempts = postTransitionSettleAttempts(terminal, request.plan);
  for (
    let attempt = 0;
    attempt < settleAttempts;
    attempt += 1
  ) {
    let verifiedIdentity: TerminalNativeIdentity | undefined;
    if (terminal.agent === "claude") {
      try {
        const parsed = terminal.adapter.observeThreadLifecycle?.({
          operation: request.operation,
          phase: "after",
          pid: terminal.pid,
          processStartedAt: request.beforeIdentity?.processStartedAt,
          cwd: terminal.terminalControl.currentPath,
          agentRows: ports.loadClaudeAgentRows(),
          beforeNativeThreadId: request.beforeIdentity?.sessionId,
          expectedNativeThreadId:
            request.operation.kind === "resume_thread"
              ? request.operation.nativeThreadId
              : undefined
        });
        if (
          parsed?.status === "verified" &&
          parsed.nativeThreadId &&
          parsed.idle === true &&
          request.beforeIdentity?.processStartedAt !== undefined
        ) {
          const observed: TerminalNativeIdentity = {
            sessionId: parsed.nativeThreadId,
            processStartedAt: request.beforeIdentity.processStartedAt,
            processUuid:
              `claude-pid:${terminal.pid}:started:` +
              String(request.beforeIdentity.processStartedAt),
            evidence: parsed.evidence ?? "claude_agents_exact_pid"
          };
          const status = await bridge.status(
            terminal.agent,
            terminal.terminalControl,
            { runtime: ports.runtimeForIdentity(observed) }
          );
          if (status.reachable && status.activity_state === "idle") {
            verifiedIdentity = observed;
          }
        }
      } catch {
        // Polling observations fail closed within the already-dispatched
        // transition; observation errors never prove a matching identity.
      }
    } else {
      const afterProbe = request.plan.steps.find((step) =>
        step.kind === "identity_probe_after"
      );
      if (
        !afterProbe ||
        afterProbe.effect !== "read_only" ||
        afterProbe.command !== "/status"
      ) {
        throw new Error(
          "the Codex lifecycle plan has no exact post-transition identity probe"
        );
      }
      const agentVersion = ports.runningVersion();
      if (!agentVersion) {
        throw new Error(
          "Codex lifecycle postcondition /status requires the exact running version before terminal input"
        );
      }
      const physicalRuntime = ports.physicalRuntime();
      const status = await bridge.status(
        terminal.agent,
        terminal.terminalControl,
        {
          runtime: physicalRuntime,
          ...(observationScrollbackLines === undefined
            ? {}
            : { scrollbackLines: observationScrollbackLines })
        }
      );
      const screenDigest = status.screen.digest;
      if (
        !probeSent &&
        status.reachable &&
        status.activity_state === "idle" &&
        screenDigest !== undefined &&
        screenDigest !== request.initialScreenDigest
      ) {
        try {
          const receipt = await bridge.submitCodexStatusProbe(
            terminal.terminalControl,
            agentVersion,
            { runtime: physicalRuntime }
          );
          postProbeBaselineDigest = receipt.observationBaselineDigest;
          observationScrollbackLines = receipt.observationScrollbackLines;
          probeSent = true;
        } catch (error) {
          if (
            !(error instanceof NativeInspectionSubmissionError) ||
            error.stage !== "not_started" ||
            error.diagnostic !== "composer_not_ready"
          ) {
            throw error;
          }
          // No text reached the composer. A resumed Codex thread may still be
          // settling its MCP startup surface, so this exact failure is safe to
          // poll until the bounded verification deadline.
        }
      } else if (
        status.reachable &&
        isFreshCodexPostProbeScreen({
          probeSent,
          screenDigest,
          postProbeBaselineDigest
        })
      ) {
        const parsed = terminal.adapter.observeThreadLifecycle?.({
          operation: request.operation,
          phase: "after",
          screen: status.screen.excerpt ?? "",
          beforeNativeThreadId: request.beforeIdentity?.sessionId,
          expectedNativeThreadId:
            request.operation.kind === "resume_thread"
              ? request.operation.nativeThreadId
              : undefined
        });
        if (
          request.operation.kind === "new_thread" &&
          parsed?.nativeThreadId &&
          exactBeforeRoots.some((identity) =>
            identity.sessionId === parsed.nativeThreadId
          )
        ) {
          throw new Error(
            `Codex /clear reported previously known native thread ` +
            `${parsed.nativeThreadId} instead of a distinct new thread`
          );
        }
        const allowedBeforeRoots = parsed?.nativeThreadId
          ? exactBeforeRoots.filter((identity) =>
              identity.sessionId !== parsed.nativeThreadId
            )
          : exactBeforeRoots;
        let observed: TerminalNativeIdentity | undefined;
        let observationSucceeded = false;
        if (parsed?.nativeThreadId) {
          observed = await ports.resolveIdentity(
            parsed.nativeThreadId,
            allowedBeforeRoots[0],
            allowedBeforeRoots.slice(1)
          );
          observationSucceeded = true;
        }
        const evidenceBefore = exactBeforeRoots.find((candidate) =>
          nativeThreadIdentityMatchesFence(observed, candidate)
        ) ?? request.beforeIdentity;
        const evidence = parsed?.nativeThreadId
          ? classifyCodexLifecyclePostcondition({
              operation: request.operation.kind,
              parsedNativeThreadId: parsed.nativeThreadId,
              observationSucceeded,
              observedIdentity: observed,
              beforeIdentity: evidenceBefore
            })
          : "invalid";
        if (
          parsed?.status === "verified" &&
          parsed.nativeThreadId &&
          evidence !== "invalid" &&
          status.activity_state === "idle"
        ) {
          verifiedIdentity = {
            sessionId: parsed.nativeThreadId,
            processUuid: evidence === "matching_after"
              ? observed?.processUuid
              : request.beforeIdentity?.processUuid,
            processBirth: evidence === "matching_after"
              ? observed?.processBirth
              : request.beforeIdentity?.processBirth,
            rollout: evidence === "matching_after"
              ? observed?.rollout
              : undefined,
            evidence: parsed.evidence ?? "codex_status_card"
          };
        }
      }
    }
    if (verifiedIdentity) {
      if (sameStableIdentity(stableIdentity, verifiedIdentity)) {
        stableCount += 1;
      } else {
        stableIdentity = verifiedIdentity;
        stableCount = 1;
      }
      if (stableCount >= 2) return verifiedIdentity;
    } else {
      stableIdentity = undefined;
      stableCount = 0;
    }
    await ports.sleep(100);
  }
  throw new Error(
    request.operation.kind === "resume_thread"
      ? `the terminal did not verify native thread ${request.operation.nativeThreadId}`
      : "the terminal did not verify a distinct new native thread"
  );
}

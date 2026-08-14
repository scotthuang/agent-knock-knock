import type { ExecutorKind } from "./executors.js";
import type {
  NativeThreadLifecycleCapabilityFacts,
  NativeThreadLifecycleObservationFacts,
  NativeThreadLifecycleObservationRequest,
  NativeThreadLifecycleObservationResult,
  NativeThreadLifecycleOperation,
  NativeThreadLifecyclePlanFacts,
  NativeThreadLifecycleProbeContext,
  NativeThreadLifecycleRecoveryTerminalFacts,
  NativeThreadLifecycleStatusProbeFacts,
  NativeThreadLifecycleStatusFacts
} from "./native-thread-lifecycle-recovery-service.js";
import type {
  TerminalAgentAdapter,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleAgentRow,
  TerminalThreadLifecycleObservationRequest
} from "./terminal-agent-adapter.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import { withCodexCompanionFences } from "./terminal-authority-policy.js";
import {
  isExactClaudeIdleComposer,
  type TerminalAgentBridge,
  type TerminalBridgeStatus,
  type ResolvedTerminalConversation
} from "./terminal-agent-bridge.js";

export function lifecycleRecoveryTerminalFacts(
  terminal: ResolvedTerminalConversation
): NativeThreadLifecycleRecoveryTerminalFacts {
  return {
    conversationId: terminal.conversationId,
    agent: terminal.agent,
    pid: terminal.pid,
    terminalControl: terminal.terminalControl
  };
}

export function codexComposerVisible(screen: string | undefined): boolean {
  return String(screen ?? "")
    .split(/\r?\n/u)
    .slice(-8)
    .some((line) => /^[›»](?:\s|$)/u.test(line.trimEnd()));
}

export function codexComposerEmpty(screen: string | undefined): boolean {
  const composers = String(screen ?? "")
    .split(/\r?\n/u)
    .slice(-8)
    .filter((line) => /^[›»](?:\s|$)/u.test(line.trimEnd()));
  return composers.length === 1 && /^[›»]\s*$/u.test(composers[0].trimEnd());
}

export function claudeComposerVisible(screen: string | undefined): boolean {
  const lines = String(screen ?? "").split(/\r?\n/u);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") {
    lines.pop();
  }
  return lines
    .slice(-8)
    .some((line) => /^\s*❯(?:\s|$)/u.test(line));
}

export function claudeComposerEmpty(screen: string | undefined): boolean {
  return isExactClaudeIdleComposer(String(screen ?? ""));
}

export function lifecycleRecoveryStatusFacts(
  agent: ExecutorKind,
  status: TerminalBridgeStatus
): NativeThreadLifecycleStatusFacts {
  const screen = status.screen.excerpt;
  return {
    reachable: status.reachable,
    activityState: status.activity_state,
    approvalBlocked: status.approval_state.blocked,
    composerVisible: agent === "codex"
      ? codexComposerVisible(screen)
      : claudeComposerVisible(screen),
    composerEmpty: agent === "codex"
      ? codexComposerEmpty(screen)
      : claudeComposerEmpty(screen),
    screenDigest: status.screen.digest
  };
}

export function lifecycleRecoveryRuntime(
  base: TerminalRuntimeIdentity,
  context: NativeThreadLifecycleProbeContext
): TerminalRuntimeIdentity {
  return context.kind === "physical"
    ? base
    : withCodexCompanionFences({
        ...base,
        nativeProcessUuid: context.processUuid,
        nativeProcessBirth: context.processBirth,
        expectedNativeSessionId: context.expectedSessionId
      }, context.companions);
}

export async function observeClaudeLifecycleRecovery(input: Readonly<{
  operation: NativeThreadLifecycleOperation;
  pid: number;
  processStartedAt: number;
  cwd: string;
  loadRows(): readonly TerminalThreadLifecycleAgentRow[];
  observe(
    request: TerminalThreadLifecycleObservationRequest
  ): NativeThreadLifecycleObservationFacts | undefined;
}>): Promise<NativeThreadLifecycleObservationResult> {
  const rows = input.loadRows();
  const observation = input.observe({
    operation: input.operation,
    phase: "before",
    pid: input.pid,
    processStartedAt: input.processStartedAt,
    cwd: input.cwd,
    agentRows: rows
  });
  return { kind: "claude_agents", observation };
}

export async function observeCodexLifecycleRecovery(input: Readonly<{
  operation: NativeThreadLifecycleOperation;
  observationBaselineDigest: string;
  status(): Promise<TerminalBridgeStatus>;
  observe(
    request: TerminalThreadLifecycleObservationRequest
  ): NativeThreadLifecycleObservationFacts | undefined;
}>): Promise<NativeThreadLifecycleObservationResult> {
  const raw = await input.status();
  const status = lifecycleRecoveryStatusFacts("codex", raw);
  const fresh = status.reachable &&
    status.activityState === "idle" &&
    !status.approvalBlocked &&
    Boolean(status.screenDigest) &&
    status.screenDigest !== input.observationBaselineDigest;
  const observation = fresh
    ? input.observe({
        operation: input.operation,
        phase: "before",
        screen: raw.screen.excerpt ?? ""
      })
    : undefined;
  return { kind: "codex_status", status, observation };
}

type RecoveryBridge = Pick<
  TerminalAgentBridge,
  "status" | "clearInputLine" | "submitCodexStatusProbe"
>;

export function createNativeThreadLifecycleRecoveryProbeAdapter(
  input: Readonly<{
    agent: ExecutorKind;
    lifecycle: Pick<TerminalAgentAdapter,
      "probeThreadLifecycle" |
      "planThreadLifecycle" |
      "observeThreadLifecycle">;
    createBridge(canonicalStoreDir: string): RecoveryBridge;
    runtime(
      control: TerminalControlRef,
      context: NativeThreadLifecycleProbeContext
    ): TerminalRuntimeIdentity;
    loadClaudeRows(
      canonicalStoreDir: string
    ): readonly TerminalThreadLifecycleAgentRow[];
  }>
) {
  let preparedBridge: RecoveryBridge | undefined;
  let lifecycleCapability:
    ReturnType<NonNullable<TerminalAgentAdapter["probeThreadLifecycle"]>> |
    undefined;
  const bridge = (): RecoveryBridge => {
    if (!preparedBridge) {
      throw new Error("lifecycle recovery terminal probe is not prepared");
    }
    return preparedBridge;
  };
  return {
    prepare(canonicalStoreDir: string): void {
      preparedBridge = input.createBridge(canonicalStoreDir);
    },
    probe(version: string | undefined): NativeThreadLifecycleCapabilityFacts |
      undefined {
      lifecycleCapability = input.lifecycle.probeThreadLifecycle?.(version);
      return lifecycleCapability ? { status: lifecycleCapability.status } : undefined;
    },
    plan(
      operation: NativeThreadLifecycleOperation,
      capability: NativeThreadLifecycleCapabilityFacts
    ): NativeThreadLifecyclePlanFacts | undefined {
      const raw = lifecycleCapability;
      lifecycleCapability = undefined;
      if (!raw || raw.status !== capability.status) {
        return undefined;
      }
      const plan = input.lifecycle.planThreadLifecycle?.(operation, raw);
      return plan ? { steps: plan.steps } : undefined;
    },
    observe(
      control: TerminalControlRef,
      canonicalStoreDir: string,
      request: NativeThreadLifecycleObservationRequest
    ): Promise<NativeThreadLifecycleObservationResult> {
      return request.kind === "claude_agents"
        ? observeClaudeLifecycleRecovery({
            ...request,
            loadRows: () => input.loadClaudeRows(canonicalStoreDir),
            observe: (observation) =>
              input.lifecycle.observeThreadLifecycle?.(observation)
          })
        : observeCodexLifecycleRecovery({
            operation: request.operation,
            observationBaselineDigest: request.observationBaselineDigest,
            status: () => bridge().status(input.agent, control, {
              runtime: input.runtime(control, request.context),
              scrollbackLines: request.observationScrollbackLines
            }),
            observe: (observation) =>
              input.lifecycle.observeThreadLifecycle?.(observation)
          });
    },
    async status(
      control: TerminalControlRef,
      context: NativeThreadLifecycleProbeContext,
      scrollbackLines?: number
    ): Promise<NativeThreadLifecycleStatusFacts> {
      const raw = await bridge().status(input.agent, control, {
        runtime: input.runtime(control, context),
        ...(scrollbackLines === undefined ? {} : { scrollbackLines })
      });
      return lifecycleRecoveryStatusFacts(input.agent, raw);
    },
    clearInputLine(
      control: TerminalControlRef,
      context: NativeThreadLifecycleProbeContext
    ): Promise<void> {
      return bridge().clearInputLine(input.agent, control, {
        runtime: input.runtime(control, context)
      });
    },
    async submitCodexStatusProbe(
      control: TerminalControlRef,
      version: string,
      context: Extract<
        NativeThreadLifecycleProbeContext,
        { kind: "codex_recovery" }
      >
    ): Promise<NativeThreadLifecycleStatusProbeFacts> {
      const submission = await bridge().submitCodexStatusProbe(
        control,
        version,
        { runtime: input.runtime(control, context) }
      );
      return {
        observationBaselineDigest: submission.observationBaselineDigest,
        observationScrollbackLines: submission.observationScrollbackLines
      };
    }
  };
}

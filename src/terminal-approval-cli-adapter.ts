import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  evaluateApprovalPolicy,
  type ApprovalCandidate
} from "./approval-policy.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation,
  type ConversationStatus,
  type Executor
} from "./protocol.js";
import {
  appendEvent,
  loadState,
  pathsForConversationDir,
  saveState,
  withStoreWriterLeaseAsync
} from "./store.js";
import {
  isTerminalApprovalDecision,
  type TerminalApprovalDecision,
  type TerminalControlRef
} from "./terminal-agent-adapter.js";
import type {
  TerminalApprovalAuthorizationContext
} from "./terminal-agent-bridge.js";
import {
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import {
  terminalScopedCodexApprovalPromptSnapshot
} from "./terminal-scoped-approval-authority.js";
import {
  claudeTranscriptApprovalIdentity,
  terminalMonitorDeadlineAt as deadlineAt,
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import {
  sameCanonicalStatePath
} from "./terminal-dispatch-ledger-codec.js";
import type {
  TerminalCommandCliOptions,
  TerminalCommandPortView,
  TerminalCommandTarget
} from "./terminal-command-cli-ports.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export type TerminalApprovalCliPorts = TerminalCommandPortView<
  | "acquireFileLock"
  | "acquireTerminalBridgeSendLock"
  | "assertExpectedHandoffTokenUsesExactTerminalSelector"
  | "assertManagedTerminalDispatchOwner"
  | "createTerminalAgentBridge"
  | "ensureTerminalBridgeMonitorAfterApproval"
  | "loadConversationFromOptions"
  | "migrateLegacyTerminalAgentIdentity"
  | "parseJsonOption"
  | "positiveMinutes"
  | "resolveTerminalConversationFromOptions"
  | "storeDirFromOptions"
  | "terminalBridgeEnabled"
  | "terminalControlFromTakeover"
  | "terminalDurableRequestForConversation"
  | "terminalList"
  | "terminalRuntimeIdentityForConversation"
>;

export interface TerminalApprovalCliDependencies {
  ports: TerminalApprovalCliPorts;
  runtime: {
    now(): Date;
    nowMs(): number;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: Record<string, unknown>
    ): void;
    printJson(value: unknown): void;
  };
  defaults: {
    agentTimeoutMinutes: number;
    agentHardTimeoutMinutes: number;
    claudeScreenApprovalTtlMs: number;
  };
}

const approvalContext =
  new AsyncLocalStorage<TerminalApprovalCliDependencies>();

function approvalRuntime(): TerminalApprovalCliDependencies {
  const runtime = approvalContext.getStore();
  if (!runtime) {
    throw new Error("Terminal approval runtime is unavailable");
  }
  return runtime;
}

type ApprovalFunctionPortName = {
  [Name in keyof TerminalApprovalCliPorts]:
    TerminalApprovalCliPorts[Name] extends
      (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalApprovalCliPorts];

function rawPort<Name extends ApprovalFunctionPortName>(
  name: Name
): TerminalApprovalCliPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = approvalRuntime().ports[name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalApprovalCliPorts[Name];
}

const acquireFileLock = rawPort("acquireFileLock");
const acquireTerminalBridgeSendLock =
  rawPort("acquireTerminalBridgeSendLock");
const assertExpectedHandoffTokenUsesExactTerminalSelector =
  rawPort("assertExpectedHandoffTokenUsesExactTerminalSelector");
const assertManagedTerminalDispatchOwner =
  rawPort("assertManagedTerminalDispatchOwner");
const createTerminalAgentBridge = rawPort("createTerminalAgentBridge");
const ensureTerminalBridgeMonitorAfterApproval =
  rawPort("ensureTerminalBridgeMonitorAfterApproval");
const loadConversationFromOptions = rawPort("loadConversationFromOptions");
const migrateLegacyTerminalAgentIdentity =
  rawPort("migrateLegacyTerminalAgentIdentity");
const parseJsonOption = rawPort("parseJsonOption");
const positiveMinutes = rawPort("positiveMinutes");
const resolveTerminalConversationFromOptions =
  rawPort("resolveTerminalConversationFromOptions");
const storeDirFromOptions = rawPort("storeDirFromOptions");
const terminalBridgeEnabled = rawPort("terminalBridgeEnabled");
const terminalControlFromTakeover = rawPort("terminalControlFromTakeover");
const terminalDurableRequestForConversation =
  rawPort("terminalDurableRequestForConversation");
const terminalRuntimeIdentityForConversation =
  rawPort("terminalRuntimeIdentityForConversation");

const terminalListCliFacade = new Proxy(
  {},
  {
    get(_target, property) {
      const operation = approvalRuntime().ports.terminalList[
        property as keyof TerminalApprovalCliPorts["terminalList"]
      ];
      return typeof operation === "function"
        ? operation.bind(approvalRuntime().ports.terminalList)
        : operation;
    }
  }
) as TerminalApprovalCliPorts["terminalList"];

const cliNow = () => approvalRuntime().runtime.now();
const cliNowMs = () => approvalRuntime().runtime.nowMs();
const runtimeLog = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>
) => approvalRuntime().runtime.log(level, event, fields);
const printJson = (value: unknown) =>
  approvalRuntime().runtime.printJson(value);

async function runApproveInContext(options) {
  const decision = terminalApprovalDecisionFromOptions(options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    assertExpectedHandoffTokenUsesExactTerminalSelector({
      options,
      terminal: terminalConversation
    });
    if (options.autoApproved === true) {
      throw new Error(
        "automatic approval requires an exact managed Turn and cannot use a raw terminal selector"
      );
    }
    if (decision !== "approve_once") {
      throw new Error(
        "terminal-scoped approval supports approve_once only; use an exact managed Turn to reject"
      );
    }
    await runTerminalConversationApprove({
      options,
      terminal: terminalConversation
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  assertAutoApprovalCallbackRoute({
    options,
    conversation: loaded.conversation,
    statePath
  });
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl) {
    throw new Error(`conversation ${conversation.conversation_id} is not controlled through a terminal`);
  }
  const autoApproved = options.autoApproved === true;
  if (autoApproved && decision !== "approve_once") {
    throw new Error("automatic approval can only dispatch approve_once");
  }
  const callbackAuthority = autoApprovalCallbackAuthorityFromOptions(options);
  if (
    !["waiting_for_agent", "waiting_for_openclaw"].includes(
      conversation.status
    ) &&
    !(autoApproved && callbackAuthority)
  ) {
    throw new Error(
      `cannot approve ${conversation.conversation_id}; conversation is ${conversation.status}`
    );
  }

  const executor = executorForConversation(conversation);
  const monitoredApproval = isRecord(nativeTakeover?.["terminal_bridge_approval"])
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const suppliedExpectedFingerprint = stringValue(options.expectedApprovalFingerprint);
  const expectedFingerprint = suppliedExpectedFingerprint ??
    monitoredApprovalFingerprint(monitoredApproval, decision);
  const claudeScreenApproval = executor.kind === "claude";
  if (claudeScreenApproval) {
    const monitoredState = isRecord(monitoredApproval?.approval_state)
      ? monitoredApproval.approval_state
      : undefined;
    const pendingDispatch = isRecord(
      nativeTakeover?.terminal_bridge_approval_dispatch
    )
      ? nativeTakeover.terminal_bridge_approval_dispatch
      : undefined;
    const lastApprovalFingerprint = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_fingerprint
    );
    const lastApprovalMessageId = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_message_id
    );
    const currentMessageId = stringValue(
      nativeTakeover?.terminal_bridge_message_id
    );
    const approvalResolvedAt = validTimestampMs(
      nativeTakeover?.terminal_bridge_approval_resolved_at
    );
    if (
      autoApproved &&
      callbackAuthority === undefined &&
      monitoredApproval === undefined &&
      pendingDispatch === undefined &&
      conversation.status === "waiting_for_agent" &&
      suppliedExpectedFingerprint !== undefined &&
      suppliedExpectedFingerprint === lastApprovalFingerprint &&
      lastApprovalMessageId !== undefined &&
      lastApprovalMessageId === currentMessageId &&
      approvalResolvedAt !== undefined
    ) {
      const monitor = ensureTerminalBridgeMonitorAfterApproval({
        conversation,
        statePath,
        logPath,
        terminalControl,
        options,
        reason: "approval_already_resolved"
      });
      printJson({
        conversation,
        approved: false,
        already_approved: true,
        blocked: false,
        reason: "Claude screen approval fingerprint was already consumed",
        terminal_control: terminalControl,
        monitor_pid: monitor.monitorPid ?? null,
        monitor_handoff_pid: monitor.handoffWatchdog?.pid ?? null
      });
      return;
    }
    // A provenance-bound callback whose approval is already absent must reach
    // the terminal+state lock.  Only the persisted callback message and the
    // locked consumed-approval receipt may classify it as an idempotent replay.
    if (callbackAuthority === undefined || monitoredApproval !== undefined) {
      const notifiedAt = validTimestampMs(monitoredApproval?.notified_at);
      if (
        conversation.status !== "waiting_for_openclaw" ||
        monitoredState?.decision_mode !== "keys" ||
        !stringValue(monitoredApproval?.fingerprint)
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval requires a current managed-turn approval notification",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        notifiedAt === undefined ||
        cliNowMs() - notifiedAt > approvalRuntime().defaults.claudeScreenApprovalTtlMs
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval expired; inspect and resolve the terminal manually",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        !suppliedExpectedFingerprint ||
        expectedFingerprint !== monitoredApprovalFingerprint(
          monitoredApproval,
          decision
        )
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval requires the latest notified fingerprint",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        pendingDispatch?.state === "reserved" &&
        pendingDispatch.terminal_bridge_message_id ===
          nativeTakeover?.terminal_bridge_message_id
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually",
          terminal_control: terminalControl
        });
        return;
      }
      if (
        expectedFingerprint ===
        stringValue(nativeTakeover?.terminal_bridge_last_approval_fingerprint)
      ) {
        printJson({
          conversation,
          approved: false,
          blocked: true,
          reason: "Claude screen approval fingerprint was already consumed",
          terminal_control: terminalControl
        });
        return;
      }
    }
  }
  return runManagedApprovalDispatch({
    options, conversation, statePath, logPath,
    nativeTakeover: nativeTakeover as Record<string, any>,
    terminalControl, executor, monitoredApproval, expectedFingerprint,
    autoApproved, claudeScreenApproval, decision
  });
}

function terminalApprovalDecisionFromOptions(
  options: Record<string, any>
): TerminalApprovalDecision {
  const value = options.decision ?? "approve_once";
  if (!isTerminalApprovalDecision(value)) {
    throw new Error(
      "--decision must be one of: approve_once, reject"
    );
  }
  return value;
}

function monitoredApprovalFingerprint(
  approval: Record<string, unknown> | undefined,
  decision: TerminalApprovalDecision
): string | undefined {
  if (decision === "approve_once") {
    return stringValue(approval?.fingerprint);
  }
  const state = isRecord(approval?.approval_state)
    ? approval.approval_state
    : undefined;
  const choices = Array.isArray(state?.choices) ? state.choices : [];
  const choice = choices.find((candidate) =>
    isRecord(candidate) && candidate.decision === decision
  );
  return isRecord(choice) ? stringValue(choice.fingerprint) : undefined;
}

function approvalPolicyCandidateForInspection({
  agent,
  currentTerminalControl,
  inspection,
  fingerprint
}: Pick<
  TerminalApprovalAuthorizationContext,
  "agent" | "inspection" | "fingerprint"
> & {
  currentTerminalControl: TerminalControlRef;
}): ApprovalCandidate {
  const evidence = inspection.approval.approvable
    ? inspection.approval.policyEvidence
    : undefined;
  return {
    agent,
    kind: evidence?.kind ?? inspection.approval.promptKind ?? "unknown",
    decisionMode: inspection.approval.approvable
      ? inspection.approval.action.mode ?? "keys"
      : undefined,
    command: evidence?.command ?? inspection.approval.command,
    cwd: evidence?.cwd ?? inspection.approval.cwd ?? currentTerminalControl.currentPath,
    fingerprint: fingerprint ?? "",
    terminalTarget: currentTerminalControl.target,
    ...(evidence?.source === "claude_transcript"
      ? {
          evidenceSource: "claude_transcript" as const,
          evidenceFingerprint: evidence.evidenceFingerprint
        }
      : {})
  };
}

async function runManagedApprovalDispatch({
  options, conversation, statePath, logPath, nativeTakeover,
  terminalControl, executor, monitoredApproval, expectedFingerprint,
  autoApproved, claudeScreenApproval, decision
}: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  logPath: string;
  nativeTakeover: Record<string, any>;
  terminalControl: TerminalControlRef;
  executor: Executor;
  monitoredApproval?: Record<string, unknown>;
  expectedFingerprint?: string;
  autoApproved: boolean;
  claudeScreenApproval: boolean;
  decision: TerminalApprovalDecision;
}): Promise<void> {
  const policyRuleId = stringValue(options.policyRuleId);
  const policyFingerprint = stringValue(options.policyFingerprint);
  const autoApprovalPolicy = autoApproved
    ? parseJsonOption(options.autoApprovalPolicyJson, "--auto-approval-policy-json")
    : undefined;
  let executorPolicyDecision;
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDirFromOptions(options),
    terminalControl,
    { timeoutMs: 30000 }
  );
  let terminalLockReleased = false;
  const releaseApprovalTerminalLock = () => {
    if (!terminalLockReleased) {
      terminalLockReleased = true;
      releaseTerminalLock();
    }
  };
  let releaseStateLock: (() => void) | undefined;
  let approvalDispatchReserved = false;
  const releaseApprovalStateLock = () => {
    if (releaseStateLock) {
      const release = releaseStateLock;
      releaseStateLock = undefined;
      release();
    }
  };
  const writerStoreDir = pathsForConversationDir(
    path.dirname(statePath)
  ).storeDir;
  const runApprovalWithStateLock = async () => {
    let approval;
    let lockedConversation = conversation;
    const currentConversation = loadState(statePath);
    const currentTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    const currentApproval = isRecord(currentTakeover?.terminal_bridge_approval)
      ? currentTakeover.terminal_bridge_approval
      : undefined;
    const callbackAuthorityState = assertAutoApprovalCallbackAuthority({
      options,
      conversation: currentConversation,
      statePath,
      takeover: currentTakeover,
      approval: currentApproval,
      expectedFingerprint
    });
    if (
      !currentControl ||
      !terminalControlsShareIncarnation(currentControl, terminalControl) ||
      (
        callbackAuthorityState !== "already_approved" &&
        (
          currentConversation.status !== conversation.status ||
          currentTakeover?.terminal_bridge_message_id !==
            nativeTakeover?.terminal_bridge_message_id ||
          (
            claudeScreenApproval &&
            monitoredApprovalFingerprint(currentApproval, decision) !==
              monitoredApprovalFingerprint(monitoredApproval, decision)
          )
        )
      )
    ) {
      throw new Error("approval state changed while waiting for terminal control; refresh status and retry");
    }
    lockedConversation = currentConversation;
    if (callbackAuthorityState === "already_approved") {
      releaseApprovalStateLock();
      printJson({
        conversation: lockedConversation,
        approved: false,
        already_approved: true,
        blocked: false,
        reason: "automatic approval callback was already handled",
        terminal_control: currentControl
      });
      return;
    }
    assertManagedTerminalDispatchOwner({
      storeDir: writerStoreDir,
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "approve"
    });
    const currentRuntimeIdentity = terminalRuntimeIdentityForConversation(
      currentConversation,
      currentControl
    );
    approval = await createTerminalAgentBridge(options).approve(
      executor.kind,
      currentControl,
      {
        decision,
        expectedFingerprint,
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: currentRuntimeIdentity,
        managedRequest: terminalDurableRequestForConversation(
          currentConversation,
          currentControl
        ),
        requiredDecisionMode:
          autoApproved && executor.kind === "claude" ? "keys" : undefined,
        authorize: autoApproved
          ? ({ agent, terminalControl: currentTerminalControl, inspection, fingerprint }) => {
              if (!autoApprovalPolicy) {
                return {
                  approved: false,
                  reason: "automatic approval requires an executor-side policy"
                };
              }
              const candidate = approvalPolicyCandidateForInspection({
                agent,
                currentTerminalControl,
                inspection,
                fingerprint
              });
              executorPolicyDecision = evaluateApprovalPolicy({
                policy: autoApprovalPolicy,
                candidate
              });
              if (executorPolicyDecision.action !== "approve") {
                return {
                  approved: false,
                  reason: `executor-side auto-approval policy rejected the current request: ${executorPolicyDecision.reason}`
                };
              }
              if (policyRuleId && executorPolicyDecision.ruleId !== policyRuleId) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval rule changed before execution"
                };
              }
              if (
                policyFingerprint &&
                executorPolicyDecision.policyFingerprint !== policyFingerprint
              ) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval policy changed before execution"
                };
              }
              return { approved: true };
            }
          : undefined,
        beforeKeyDispatch: claudeScreenApproval
          ? ({ fingerprint, terminalControl: dispatchControl, inspection, keys }) => {
              if (autoApproved) {
                if (!autoApprovalPolicy) {
                  throw new Error(
                    "automatic approval requires an executor-side policy before dispatch"
                  );
                }
                const freshPolicyDecision = evaluateApprovalPolicy({
                  policy: autoApprovalPolicy,
                  candidate: approvalPolicyCandidateForInspection({
                    agent: executor.kind,
                    currentTerminalControl: dispatchControl,
                    inspection,
                    fingerprint
                  })
                });
                if (freshPolicyDecision.action !== "approve") {
                  throw new Error(
                    `executor-side auto-approval policy rejected the recaptured request: ${freshPolicyDecision.reason}`
                  );
                }
                if (
                  executorPolicyDecision?.ruleId &&
                  freshPolicyDecision.ruleId !== executorPolicyDecision.ruleId
                ) {
                  throw new Error(
                    "executor-side auto-approval rule changed after recapture"
                  );
                }
                if (policyRuleId && freshPolicyDecision.ruleId !== policyRuleId) {
                  throw new Error(
                    "executor-side auto-approval rule changed before dispatch"
                  );
                }
                if (
                  policyFingerprint &&
                  freshPolicyDecision.policyFingerprint !== policyFingerprint
                ) {
                  throw new Error(
                    "executor-side auto-approval policy changed before dispatch"
                  );
                }
                executorPolicyDecision = freshPolicyDecision;
              }
              if (approvalDispatchReserved) {
                throw new Error("Claude approval dispatch was already reserved");
              }
              approvalDispatchReserved = true;
              if (!releaseStateLock) {
                throw new Error(
                  "approval state lock was released before terminal dispatch"
                );
              }
              const latestConversation = loadState(statePath);
              const latestTakeover = isRecord(latestConversation.native_session_takeover)
                ? latestConversation.native_session_takeover
                : undefined;
              const latestControl = terminalControlFromTakeover(latestTakeover);
              const latestApproval = isRecord(latestTakeover?.terminal_bridge_approval)
                ? latestTakeover.terminal_bridge_approval
                : undefined;
              const latestNotifiedAt = validTimestampMs(latestApproval?.notified_at);
              const latestApprovalState = isRecord(latestApproval?.approval_state)
                ? latestApproval.approval_state
                : undefined;
              const latestPolicyEvidence = isRecord(latestApprovalState?.policy_evidence)
                ? latestApprovalState.policy_evidence
                : undefined;
              const recapturedPolicyEvidence = inspection.approval.approvable
                ? inspection.approval.policyEvidence
                : undefined;
              const latestDispatch = isRecord(
                latestTakeover?.terminal_bridge_approval_dispatch
              )
                ? latestTakeover.terminal_bridge_approval_dispatch
                : undefined;
              if (
                !latestTakeover ||
                latestConversation.status !== "waiting_for_openclaw" ||
                latestTakeover.terminal_bridge_message_id !==
                  nativeTakeover?.terminal_bridge_message_id ||
                monitoredApprovalFingerprint(latestApproval, decision) !==
                  fingerprint ||
                latestNotifiedAt === undefined ||
                cliNowMs() - latestNotifiedAt > approvalRuntime().defaults.claudeScreenApprovalTtlMs ||
                expectedFingerprint !== fingerprint ||
                !terminalControlsShareIncarnation(
                  latestControl,
                  dispatchControl
                ) ||
                (
                  autoApproved &&
                  (
                    latestPolicyEvidence?.source !== "claude_transcript" ||
                    latestPolicyEvidence.evidence_fingerprint !==
                      recapturedPolicyEvidence?.evidenceFingerprint
                  )
                )
              ) {
                throw new Error(
                  "approval state changed before terminal dispatch; refresh status and retry"
                );
              }
              if (
                latestDispatch?.state === "reserved" &&
                latestDispatch.terminal_bridge_message_id ===
                  latestTakeover.terminal_bridge_message_id
              ) {
                throw new Error(
                  "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually"
                );
              }
              const reservedAt = cliNow().toISOString();
              const reservedConversation = {
                ...latestConversation,
                native_session_takeover: {
                  ...latestTakeover,
                  terminal_bridge_approval_dispatch: {
                    state: "reserved",
                    attempt_id: randomUUID(),
                    decision,
                    fingerprint,
                    keys,
                    terminal_target: dispatchControl.target,
                    terminal_bridge_message_id:
                      latestTakeover.terminal_bridge_message_id,
                    reserved_at: reservedAt
                  }
                },
                updated_at: reservedAt
              };
              saveState(statePath, reservedConversation);
              lockedConversation = reservedConversation;
            }
          : undefined
      }
    );
    const actualFingerprint = approval.fingerprint;
    const effectivePolicyRuleId = executorPolicyDecision?.ruleId ?? policyRuleId;
    const effectivePolicyFingerprint =
      executorPolicyDecision?.policyFingerprint ?? policyFingerprint;
    if (approval.decisionDispatched !== true) {
      releaseApprovalStateLock();
      if (autoApproved) {
        appendEvent(logPath, {
          ts: cliNow().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_auto_approval_decision",
          action: "rejected",
          reason: approval.reason,
          terminal_control: terminalControl,
          expected_fingerprint: expectedFingerprint,
          actual_fingerprint: actualFingerprint,
          policy_rule_id: effectivePolicyRuleId,
          policy_fingerprint: effectivePolicyFingerprint
        });
      }
      printJson({
        conversation,
        approved: false,
        decision,
        decision_dispatched: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        expected_approval_fingerprint: expectedFingerprint,
        actual_approval_fingerprint: actualFingerprint,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    appendEvent(logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_approval_send",
      decision,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    if (autoApproved) {
      appendEvent(logPath, {
        ts: cliNow().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_auto_approval_decision",
        action: "approved",
        terminal_control: terminalControl,
        approval_fingerprint: actualFingerprint,
        policy_rule_id: effectivePolicyRuleId,
        policy_fingerprint: effectivePolicyFingerprint
      });
    }
    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      decision,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    const nativeTakeoverForUpdate: Record<string, unknown> = isRecord(lockedConversation.native_session_takeover)
      ? { ...lockedConversation.native_session_takeover }
      : {};
    const resolvedApproval = isRecord(
      nativeTakeoverForUpdate.terminal_bridge_approval
    )
      ? nativeTakeoverForUpdate.terminal_bridge_approval
      : undefined;
    const resolvedApprovalScreenDigest = stringValue(
      resolvedApproval?.screen_digest
    );
    const resolvedApprovalState = isRecord(resolvedApproval?.approval_state)
      ? resolvedApproval.approval_state
      : undefined;
    const resolvedTranscriptIdentity =
      claudeTranscriptApprovalIdentity(resolvedApprovalState);
    const approvalResolvedAt = cliNow().toISOString();
    const agentTimeoutMinutes = Number(
      options.agentTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_inactivity_timeout_minutes ??
        approvalRuntime().defaults.agentTimeoutMinutes
    );
    const agentHardTimeoutMinutes = positiveMinutes(
      options.agentHardTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_hard_timeout_minutes ??
        approvalRuntime().defaults.agentHardTimeoutMinutes,
      "--agent-hard-timeout-minutes"
    );
    const nextNativeTakeover: Record<string, unknown> = {
      ...nativeTakeoverForUpdate,
      terminal_bridge_approval: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_approval_resolved_at: approvalResolvedAt,
      terminal_bridge_last_approval_fingerprint: actualFingerprint,
      terminal_bridge_last_approval_decision: decision,
      terminal_bridge_last_approval_screen_digest:
        resolvedApprovalScreenDigest,
      terminal_bridge_last_approval_request_id:
        resolvedTranscriptIdentity?.requestId,
      terminal_bridge_last_approval_evidence_fingerprint:
        resolvedTranscriptIdentity?.evidenceFingerprint,
      terminal_bridge_last_approval_prompt_cleared_at: undefined,
      terminal_bridge_last_approval_at: approvalResolvedAt,
      terminal_bridge_last_approval_message_id:
        nativeTakeoverForUpdate.terminal_bridge_message_id,
      terminal_bridge_monitor_lock_version: monitorOwner.LOCK_VERSION,
      terminal_bridge_monitor_started_at: approvalResolvedAt,
      terminal_bridge_last_activity_at: approvalResolvedAt,
      terminal_bridge_last_activity_reason: "approval resolved",
      terminal_bridge_inactivity_timeout_minutes: agentTimeoutMinutes,
      terminal_bridge_hard_timeout_minutes: agentHardTimeoutMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(approvalResolvedAt, agentTimeoutMinutes),
      terminal_bridge_hard_deadline_at: deadlineAt(
        stringValue(nativeTakeoverForUpdate.terminal_bridge_started_at) ?? approvalResolvedAt,
        agentHardTimeoutMinutes
      )
    };
    delete nextNativeTakeover.terminal_bridge_approval;
    delete nextNativeTakeover.terminal_bridge_approval_dispatch;
    delete nextNativeTakeover.terminal_bridge_last_approval_prompt_cleared_at;
    const nextConversation = {
      ...lockedConversation,
      status: terminalBridgeEnabled(lockedConversation)
        ? "waiting_for_agent" as const
        : lockedConversation.status,
      native_session_takeover: nextNativeTakeover,
      updated_at: approvalResolvedAt
    };
    saveState(statePath, nextConversation);
    releaseApprovalStateLock();

    const bridgeMonitor = ensureTerminalBridgeMonitorAfterApproval({
      conversation: nextConversation,
      statePath,
      logPath,
      terminalControl,
      options
    });

    printJson({
      conversation: nextConversation,
      approved: decision === "approve_once",
      rejected: decision === "reject",
      decision,
      decision_dispatched: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint,
      monitor_pid: bridgeMonitor.monitorPid ?? null,
      monitor_handoff_pid: bridgeMonitor.handoffWatchdog?.pid ?? null
    });
  };
  try {
    return await withStoreWriterLeaseAsync(writerStoreDir, async () => {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
      try {
        return await runApprovalWithStateLock();
      } finally {
        releaseApprovalStateLock();
      }
    });
  } finally {
    try {
      releaseApprovalStateLock();
    } finally {
      releaseApprovalTerminalLock();
    }
  }
}

function assertAutoApprovalCallbackAuthority(input: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
  takeover: Record<string, unknown> | undefined;
  approval: Record<string, unknown> | undefined;
  expectedFingerprint?: string;
}): "not_callback" | "current" | "already_approved" {
  if (input.options.autoApproved !== true) {
    return "not_callback";
  }
  const expected = autoApprovalCallbackAuthorityFromOptions(input.options);
  if (!expected) {
    return "not_callback";
  }
  assertAutoApprovalCallbackRoute({
    options: input.options,
    conversation: input.conversation,
    statePath: input.statePath
  });
  const delivery = isRecord(input.conversation.callback_delivery)
    ? input.conversation.callback_delivery
    : undefined;
  const callbackMessage = isRecord(delivery?.message)
    ? delivery.message
    : undefined;
  const callbackMetadata = isRecord(callbackMessage?.metadata)
    ? callbackMessage.metadata
    : undefined;
  const callbackCandidate = isRecord(callbackMetadata?.approval_candidate)
    ? callbackMetadata.approval_candidate
    : undefined;
  const callbackTerminalStatus = isRecord(callbackMetadata?.terminal_status)
    ? callbackMetadata.terminal_status
    : undefined;
  const callbackApprovalState = isRecord(callbackTerminalStatus?.approval_state)
    ? callbackTerminalStatus.approval_state
    : undefined;
  const persistedApprovalState = isRecord(input.approval?.approval_state)
    ? input.approval.approval_state
    : undefined;
  const callbackFingerprints = [
    stringValue(callbackMetadata?.approval_fingerprint),
    stringValue(callbackCandidate?.fingerprint),
    stringValue(callbackApprovalState?.fingerprint)
  ];
  const commonAuthorityMismatch =
    delivery?.kind !== "approval_notification" ||
      stringValue(callbackMessage?.id) !== expected.messageId ||
      stringValue(callbackMessage?.conversation_id) !== expected.conversationId ||
      stringValue(callbackMessage?.session_id) !== expected.sessionId ||
      stringValue(callbackMessage?.turn_id) !== expected.turnId ||
      !input.expectedFingerprint ||
      !/^[a-f0-9]{64}$/u.test(input.expectedFingerprint) ||
      callbackFingerprints.some((value) => value !== input.expectedFingerprint) ||
      input.takeover?.terminal_bridge !== true;
  if (commonAuthorityMismatch) {
    throw new Error(
      "automatic approval callback no longer matches the locked Turn state; refresh status and retry"
    );
  }
  if (input.approval) {
    const currentFingerprints = [
      stringValue(input.approval.fingerprint),
      stringValue(persistedApprovalState?.fingerprint)
    ];
    if (input.conversation.status !== "waiting_for_openclaw" ||
        currentFingerprints.some((value) => value !== input.expectedFingerprint) ||
        stringValue(input.approval.callback_message_id) !== expected.messageId) {
      throw new Error(
        "automatic approval callback no longer matches the locked Turn state; refresh status and retry"
      );
    }
    return "current";
  }
  if (
    input.takeover?.terminal_bridge_approval !== undefined ||
    input.takeover?.terminal_bridge_approval_dispatch !== undefined ||
    !isPostApprovalCallbackReplayStatus(input.conversation.status) ||
    stringValue(input.takeover?.terminal_bridge_message_id) !==
      expected.messageId ||
    stringValue(input.takeover?.terminal_bridge_last_approval_message_id) !==
      expected.messageId ||
    stringValue(input.takeover?.terminal_bridge_last_approval_fingerprint) !==
      input.expectedFingerprint ||
    validTimestampMs(
      input.takeover?.terminal_bridge_approval_resolved_at
    ) === undefined
  ) {
    throw new Error(
      "automatic approval callback no longer matches the locked Turn receipt; refresh status and retry"
    );
  }
  return "already_approved";
}

function isPostApprovalCallbackReplayStatus(
  status: ConversationStatus
): boolean {
  return [
    "waiting_for_agent",
    "running",
    "idle",
    "stalled",
    "callback_pending",
    "callback_failed",
    "failed",
    "closed",
    "cancelled",
    "cancelling"
  ].includes(status);
}

function autoApprovalCallbackAuthorityFromOptions(
  options: Record<string, any>
): {
  conversationId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  openclawSession: string;
} | undefined {
  const candidate = {
    conversationId: stringValue(options.expectedCallbackConversationId),
    sessionId: stringValue(options.expectedCallbackSessionId),
    turnId: stringValue(options.expectedCallbackTurnId),
    messageId: stringValue(options.expectedCallbackMessageId),
    openclawSession: stringValue(options.expectedCallbackOpenclawSession)
  };
  const values = Object.values(candidate);
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  if (values.some((value) => value === undefined)) {
    throw new Error(
      "automatic approval callback identity is incomplete; no approval key was sent"
    );
  }
  return candidate as {
    conversationId: string;
    sessionId: string;
    turnId: string;
    messageId: string;
    openclawSession: string;
  };
}

function assertAutoApprovalCallbackRoute(input: {
  options: Record<string, any>;
  conversation: Conversation;
  statePath: string;
}): void {
  if (input.options.autoApproved !== true) {
    return;
  }
  const expected = autoApprovalCallbackAuthorityFromOptions(input.options);
  if (!expected) {
    return;
  }
  const storedOpenClawSession = stringValue(
    input.conversation.gateway_session ?? input.conversation.openclaw_session
  );
  if (
    input.conversation.conversation_id !== expected.conversationId ||
    sessionIdForConversation(input.conversation) !== expected.sessionId ||
    turnIdForConversation(input.conversation) !== expected.turnId ||
    !sameCanonicalStatePath(input.conversation.state_path, input.statePath) ||
    storedOpenClawSession !== expected.openclawSession
  ) {
    throw new Error(
      "automatic approval callback does not match the selected Turn state; no state was changed"
    );
  }
}

async function runTerminalConversationApprove({
  options,
  terminal
}: {
  options: Record<string, any>;
  terminal: TerminalCommandTarget;
}) {
  const { conversationId, agent, terminalControl, pid } = terminal;
  const storeDir = storeDirFromOptions(options);
  const releaseTerminalLock = acquireTerminalBridgeSendLock(
    storeDir,
    terminalControl,
    { timeoutMs: 30000 }
  );
  try {
    if (agent === "claude") {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: true,
        reason: "Claude screen approval requires `send --background` so AKK can bind it to an active managed turn",
        terminal_control: terminalControl
      });
      return;
    }
    const suppliedTerminalToken = stringValue(options.expectedTerminalToken);
    const initialResolution = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
      options,
      terminal
    });
    if (initialResolution.state === "blocked") {
      throw new Error(initialResolution.reason);
    }
    if (initialResolution.state === "unmanaged" && suppliedTerminalToken) {
      throw new Error(
        "--expected-terminal-token does not match an advertised terminal-scoped Codex approval"
      );
    }
    if (
      initialResolution.state === "eligible" &&
      suppliedTerminalToken !== initialResolution.boundary.token
    ) {
      throw new Error(
        "terminal-scoped Codex approval token is missing or stale; refresh AKK list"
      );
    }
    const runtime = {
      pid,
      cwd: terminalControl.currentPath,
      conversationId,
      terminalTarget: terminalControl.target
    };
    const approveCurrentPrompt = async (terminalScoped: boolean) =>
      createTerminalAgentBridge(options).approve(agent, terminalControl, {
        expectedFingerprint: stringValue(options.expectedApprovalFingerprint),
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime,
        beforeKeyDispatch: terminalScoped
          ? async (context) => {
              const approvalSnapshot =
                terminalScopedCodexApprovalPromptSnapshot({
                  approvable: true,
                  fingerprint: context.fingerprint,
                  keys: context.keys,
                  decision_mode:
                    context.inspection.approval.approvable
                      ? context.inspection.approval.action.mode ?? "keys"
                      : undefined,
                  request_id:
                    context.inspection.approval.approvable
                      ? context.inspection.approval.action.requestId
                      : undefined
                });
              const current = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
                options,
                terminal,
                approvalSnapshot
              });
              if (
                current.state !== "eligible" ||
                current.boundary.token !== suppliedTerminalToken
              ) {
                throw new Error(
                  current.state === "blocked"
                    ? current.reason
                    : "terminal-scoped Codex approval authority changed before key dispatch"
                );
              }
            }
          : undefined
      });
    const terminalScoped = initialResolution.state === "eligible";
    const approval = terminalScoped
      ? await withStoreWriterLeaseAsync(storeDir, async () => {
          const current = await terminalListCliFacade.resolveTerminalScopedCodexApproval({
            options,
            terminal
          });
          if (
            current.state !== "eligible" ||
            current.boundary.token !== suppliedTerminalToken
          ) {
            throw new Error(
              current.state === "blocked"
                ? current.reason
                : "terminal-scoped Codex approval authority changed while waiting for Store control"
            );
          }
          return approveCurrentPrompt(true);
        })
      : await approveCurrentPrompt(false);
    if (!approval.approved) {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversationId,
      agent,
      terminal_target: terminalControl.target,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId
    });

    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      approved: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      approval_fingerprint: approval.fingerprint,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      terminal_scoped: terminalScoped,
      ...(terminalScoped
        ? {
            durable_dispatch_receipt: false,
            uncertain_outcome_recovery:
              "refresh status and inspect the live prompt; do not retry blindly"
          }
        : {})
    });
  } finally {
    releaseTerminalLock();
  }
}

export async function runTerminalApproval(
  dependencies: TerminalApprovalCliDependencies,
  options: TerminalCommandCliOptions
): Promise<void> {
  return approvalContext.run(
    dependencies,
    () => runApproveInContext(options)
  );
}

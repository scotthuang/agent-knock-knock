import path from "node:path";

import { validateCodexRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import { executorForConversation, turnIdForConversation } from "./protocol.js";
import { pathsForConversationDir } from "./store.js";
import { terminalControlsShareIncarnation } from
  "./terminal-authority-policy.js";
import {
  withCanonicalMutationLocks,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import { decideTerminalSubmissionRetry } from
  "./terminal-submission-retry-service.js";
import { cliNow } from "./cli-runtime-context.js";
import type { TerminalCommandCliOptions } from
  "./terminal-command-cli-ports.js";
import {
  TerminalSubmissionRetryReconciliation,
  type TerminalSubmissionRetryFlowContext,
  type TerminalSubmissionRetryFlowState,
  type TerminalSubmissionRetryInvocation
} from "./terminal-submission-retry-reconciliation.js";
import { TerminalSubmissionRetryTransport } from
  "./terminal-submission-retry-transport.js";
import type { TerminalSubmissionRetryApplicationPorts } from
  "./terminal-submission-retry-ports.js";

export class TerminalSubmissionRetryApplication {
  constructor(
    private readonly ports: TerminalSubmissionRetryApplicationPorts,
    private readonly reconciliation: TerminalSubmissionRetryReconciliation,
    private readonly transport: TerminalSubmissionRetryTransport
  ) {}

  assertTerminalSubmissionRetryOptions(
    options: TerminalCommandCliOptions
  ): string {
    const turnId = this.ports.required(
      stringValue(options.turn),
      "--turn is required"
    );
    const allowed = new Set(["turn", "storeDir"]);
    const conflicts = Object.keys(options).filter(
      (option) => options[option] !== undefined && !allowed.has(option)
    );
    if (conflicts.length > 0) {
      throw new Error(
        "send --turn is an exact submission recovery form and cannot be " +
        `combined with ${conflicts.map((option) => `--${option}`).join(", ")}; ` +
        "no terminal input was sent"
      );
    }
    return turnId;
  }

  terminalSubmissionRetryIsEligible(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): boolean {
    const legacyEligible = !state.attempt &&
      state.conversation.status === "stalled" &&
      state.submission.status === "uncertain" &&
      state.submission.last_proven_stage === "text_injected" &&
      context.currentMessageId === context.originalMessageId;
    if (legacyEligible || (state.attempt && state.attempt.state !== "agent_accepted")) {
      return true;
    }
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl: context.invocation.terminalControl,
      attempt: state.attempt,
      outcome: "refused",
      terminalInputSent: false,
      reason: "The Turn is not an eligible incomplete submission recovery; no terminal input was sent."
    });
    return false;
  }

  async recoverTerminalSubmissionRetryAcceptance(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): Promise<boolean> {
    const {
      options, terminalControl, live, statePath, logPath, storeDir
    } = context.invocation;
    const deferredAccepted = context.deferred
      ? await deferredRecoveryAdapter.recoverAcceptedDeferredForegroundDispatch(
          this.ports.deferredForegroundRecoveryAdapterPorts(),
          {
            options,
            scope: context.deferred.scope,
            storeDir,
            terminal: live,
            transfer: context.deferred.transfer,
            boundary: context.deferred.boundary
          }
        )
      : false;
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    if (deferredAccepted) {
      const finalized = this.reconciliation.finalizeDeferredTerminalSubmissionRetryAccepted({
        statePath,
        scopes: context.scopes,
        resources: context.resources,
        attempt: state.attempt
      });
      state.conversation = finalized.conversation;
      state.attempt = finalized.attempt;
      this.ports.startTerminalBridgeMonitorForConversation({
        conversation: state.conversation,
        statePath,
        logPath,
        options
      });
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: state.conversation,
        terminalControl,
        attempt: state.attempt,
        outcome: "agent_accepted",
        terminalInputSent: false,
        reason: "Deferred native acceptance and source/target Session bindings were reconciled without terminal input."
      });
      return true;
    }
    const acceptedEvidence = context.deferred
      ? undefined
      : await context.execution.detectAcceptance({
          executor: "codex",
          conversation: state.conversation,
          terminalControl,
          ...this.ports.terminalAcceptanceCompanionFences(
            state.conversation,
            terminalControl
          )
        });
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    if (!acceptedEvidence) return false;
    const repaired = this.reconciliation.terminalSubmissionRetryAccepted({
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      evidence: acceptedEvidence,
      requestText: context.requestText,
      at: cliNow().toISOString(),
      statePath,
      logPath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt,
      terminalInputSent: false
    });
    state.conversation = repaired.conversation;
    state.attempt = repaired.attempt;
    this.ports.startTerminalBridgeMonitorForConversation({
      conversation: state.conversation,
      statePath,
      logPath,
      options
    });
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl,
      attempt: state.attempt,
      outcome: "agent_accepted",
      terminalInputSent: false,
      reason: "Native Codex acceptance was reconciled; no terminal input was sent."
    });
    return true;
  }

  finishPendingTerminalSubmissionRetry(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState,
    alreadyReconciled: boolean
  ): boolean {
    if (state.attempt?.state !== "enter_dispatched") return false;
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath: context.invocation.statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    if (!alreadyReconciled) {
      state.conversation = this.reconciliation.reconcileTerminalSubmissionRetryPending({
        conversation: state.conversation,
        submission: state.submission,
        ledger: state.ledger,
        attempt: state.attempt,
        requestText: context.requestText,
        statePath: context.invocation.statePath,
        logPath: context.invocation.logPath,
        scopes: context.scopes,
        resources: context.resources,
        deferred: context.deferred
      });
    }
    this.ports.startTerminalBridgeMonitorForConversation({
      conversation: state.conversation,
      statePath: context.invocation.statePath,
      logPath: context.invocation.logPath,
      options: context.invocation.options
    });
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl: context.invocation.terminalControl,
      attempt: state.attempt,
      outcome: "enter_dispatched",
      terminalInputSent: false,
      reason: "The durable retry Enter was reconciled without additional terminal input; native acceptance remains pending."
    });
    return true;
  }

  terminalSubmissionRetryHasInputAuthority(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): boolean {
    if (
      !context.deferred ||
      validateCodexRolloutAcceptanceAnchor(
        context.takeover?.codex_rollout_acceptance_anchor
      )?.version === 3
    ) {
      return true;
    }
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: state.conversation,
      terminalControl: context.invocation.terminalControl,
      attempt: state.attempt,
      outcome: "refused",
      terminalInputSent: false,
      reason: "Deferred submission retry requires a candidate-set Codex acceptance anchor before any terminal input; no terminal input was sent."
    });
    return false;
  }

  async runTerminalSubmissionRetryNoInputRecovery(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): Promise<boolean> {
    const pendingRetryReconciled =
      this.reconciliation.reconcileTerminalSubmissionRetryDeferredPending(context, state);
    if (await this.reconciliation.recoverPartialTerminalSubmissionRetryAcceptance(context, state)) {
      return true;
    }
    if (!this.terminalSubmissionRetryIsEligible(context, state)) return true;
    if (await this.recoverTerminalSubmissionRetryAcceptance(context, state)) {
      return true;
    }
    if (this.finishPendingTerminalSubmissionRetry(
      context,
      state,
      pendingRetryReconciled
    )) {
      return true;
    }
    return !this.terminalSubmissionRetryHasInputAuthority(context, state);
  }

  async runTerminalSubmissionRetryDecision(
    context: TerminalSubmissionRetryFlowContext,
    state: TerminalSubmissionRetryFlowState
  ): Promise<void> {
    const {
      options, bridge, terminalControl, storeDir, statePath, logPath
    } = context.invocation;
    if (context.deferred) {
      await this.ports.assertDeferredCodexForegroundBindingBoundary({
        options,
        scope: context.deferred.scope,
        boundary: context.deferred.boundary,
        expectedSourceStatus: "transitioning",
        requireNoDispatch: false,
        requireEmptyComposer: false
      });
    }
    const observation = await bridge.observeCodexComposer(
      terminalControl,
      context.requestText,
      { runtime: this.ports.terminalRuntimeIdentityForConversation(
        state.conversation,
        terminalControl
      ) }
    );
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath,
      exactTurnId: context.invocation.exactTurnId
    });
    const decision = decideTerminalSubmissionRetry({
      agent: "codex",
      exactTurnTarget: true,
      accepted: false,
      composer: observation.state,
      submissionStatus: stringValue(state.submission.status),
      lastProvenStage: stringValue(state.submission.last_proven_stage),
      submissionTextInjectedAt: stringValue(state.submission.text_injected_at),
      enterDispatchedAt: stringValue(state.submission.enter_dispatched_at),
      enterNotAttemptedAt: stringValue(state.submission.enter_not_attempted_at),
      enterNotAttemptedReason: stringValue(
        state.submission.enter_not_attempted_reason
      ),
      ledgerStatus: stringValue(state.ledger.status),
      ledgerTextInjectedAt: stringValue(state.ledger.text_injected_at),
      ledgerEnterDispatchedAt: stringValue(state.ledger.enter_dispatched_at),
      ledgerEnterNotAttemptedAt: stringValue(state.ledger.enter_not_attempted_at),
      ledgerEnterNotAttemptedReason: stringValue(
        state.ledger.enter_not_attempted_reason
      ),
      ledgerAgentAcceptedAt: stringValue(state.ledger.agent_accepted_at),
      originalMessageId: context.originalMessageId,
      currentMessageId: stringValue(
        context.takeover?.terminal_bridge_message_id
      ),
      attempt: state.attempt
    });
    if (decision.action === "refuse") {
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: state.conversation,
        terminalControl,
        attempt: state.attempt,
        outcome: "refused",
        terminalInputSent: false,
        reason: `${decision.reason}; no terminal input was sent.`
      });
      return;
    }
    if (decision.action === "repair_accepted") {
      throw new Error(
        "retry metadata claims acceptance without native evidence; no terminal input was sent"
      );
    }
    if (
      decision.action === "start_replacement" ||
      decision.action === "resume_replacement"
    ) {
      await this.transport.runTerminalSubmissionReplacement({
        options,
        bridge,
        execution: context.execution,
        observation,
        decision,
        conversation: state.conversation,
        submission: state.submission,
        ledger: state.ledger,
        requestText: context.requestText,
        requestHash: context.requestHash,
        originalMessageId: context.originalMessageId,
        terminalControl,
        storeDir,
        statePath,
        logPath,
        scopes: context.scopes,
        resources: context.resources,
        attempt: state.attempt,
        deferred: context.deferred
      });
      return;
    }
    await this.transport.runTerminalSubmissionExactDraftEnter({
      options,
      bridge,
      execution: context.execution,
      conversation: state.conversation,
      submission: state.submission,
      ledger: state.ledger,
      requestText: context.requestText,
      requestHash: context.requestHash,
      originalMessageId: context.originalMessageId,
      activeMessageId: decision.activeMessageId,
      terminalControl,
      storeDir,
      statePath,
      logPath,
      scopes: context.scopes,
      resources: context.resources,
      attempt: state.attempt,
      deferred: context.deferred
    });
  }

  async runTerminalSubmissionRetryLocked(input: {
    invocation: TerminalSubmissionRetryInvocation;
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
  }): Promise<void> {
    const freshConversation = this.reconciliation.loadExactTerminalSubmissionRetryTurn({
      statePath: input.invocation.statePath,
      exactTurnId: input.invocation.exactTurnId
    });
    if (freshConversation.status === "closed") {
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: freshConversation,
        terminalControl: input.invocation.terminalControl,
        outcome: "refused",
        terminalInputSent: false,
        reason:
          "The Turn was explicitly closed; no terminal input was sent and no " +
          "retry state was changed."
      });
      return;
    }
    const authority = this.reconciliation.loadTerminalSubmissionRetryLockedAuthority(input);
    if (authority.lifecycleSettled) {
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: authority.conversation,
        terminalControl: input.invocation.terminalControl,
        attempt: authority.attempt,
        outcome: "refused",
        terminalInputSent: false,
        reason: "The Turn lifecycle is already settled; no terminal input was sent."
      });
      return;
    }
    const prepared = this.reconciliation.prepareTerminalSubmissionRetryDeferredContext({
      invocation: input.invocation,
      authority,
      scopes: input.scopes,
      resources: input.resources
    });
    const state: TerminalSubmissionRetryFlowState = {
      conversation: authority.conversation,
      submission: authority.submission,
      ledger: prepared.ledger,
      attempt: authority.attempt
    };
    const context: TerminalSubmissionRetryFlowContext = {
      invocation: input.invocation,
      scopes: input.scopes,
      resources: input.resources,
      execution: this.ports.terminalDispatchExecution(
        input.invocation.options,
        input.invocation.bridge
      ),
      deferred: prepared.deferred,
      takeover: authority.takeover,
      currentMessageId: authority.currentMessageId,
      originalMessageId: authority.originalMessageId,
      requestText: authority.requestText,
      requestHash: authority.requestHash
    };
    if (await this.runTerminalSubmissionRetryNoInputRecovery(context, state)) return;
    await this.runTerminalSubmissionRetryDecision(context, state);
  }

  async runTerminalSubmissionRetry(
    options: TerminalCommandCliOptions
  ): Promise<void> {
    const exactTurnId = this.assertTerminalSubmissionRetryOptions(options);
    const loaded = this.ports.loadConversationFromOptions(options);
    const { statePath, logPath } = loaded;
    const storePaths = pathsForConversationDir(path.dirname(statePath));
    const storeDir = storePaths.storeDir;
    if (
      path.resolve(storePaths.statePath) !== path.resolve(statePath) ||
      path.basename(storePaths.conversationDir) !== exactTurnId ||
      turnIdForConversation(loaded.conversation) !== exactTurnId
    ) {
      throw new Error(
        "send --turn did not resolve one canonical Turn; no terminal input was sent"
      );
    }
    const initialTakeover = isRecord(loaded.conversation.native_session_takeover)
      ? loaded.conversation.native_session_takeover
      : undefined;
    const storedControl = this.ports.terminalControlFromTakeover(initialTakeover);
    const pid = Number(initialTakeover?.terminal_agent_pid);
    if (!storedControl || !Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(
        `turn ${exactTurnId} is not attached to a live terminal; no terminal input was sent`
      );
    }
    if (executorForConversation(loaded.conversation).kind !== "codex") {
      throw new Error(
        "terminal submission retry is supported only for Codex; no terminal input was sent"
      );
    }
    const bridge = this.ports.createTerminalAgentBridge(options);
    const live = await bridge.resolveStoredTerminal(
      "codex",
      pid,
      storedControl,
      this.ports.terminalRuntimeIdentityForConversation(loaded.conversation, storedControl)
    );
    if (!terminalControlsShareIncarnation(live.terminalControl, storedControl)) {
      throw new Error(
        "terminal control changed before submission retry; no terminal input was sent"
      );
    }
    const terminalControl = live.terminalControl;
    await withCanonicalMutationLocks(
      this.ports.terminalWriterMutationLocks(storeDir, terminalControl),
      async (scopes, resources) => this.ports.withTerminalDispatchStateScope(
        scopes,
        resources,
        statePath,
        logPath,
        async (dispatchScopes, dispatchResources) =>
          this.runTerminalSubmissionRetryLocked({
            invocation: {
              options,
              exactTurnId,
              statePath,
              logPath,
              storeDir,
              bridge,
              live,
              terminalControl
            },
            scopes: dispatchScopes,
            resources: dispatchResources
          })
      )
    );
  }

}

import { randomUUID } from "node:crypto";

import { nonBlankString as stringValue } from "./value-guards.js";
import { turnIdForConversation, type Conversation } from "./protocol.js";
import { appendEvent, loadState, saveState } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  TerminalAgentBridge,
  TerminalCodexComposerObservation
} from "./terminal-agent-bridge.js";
import {
  terminalSubmissionRetryLedgerFields,
  type TerminalSubmissionRetryDecision,
  type TerminalSubmissionRetryRecord
} from "./terminal-submission-retry-service.js";
import type {
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import * as deferredRecoveryAdapter from
  "./deferred-foreground-recovery-cli-adapter.js";
import { deferredForegroundBoundaryProjection } from
  "./deferred-foreground-preparation-cli-adapter.js";
import type { TerminalDispatchExecutionService } from
  "./terminal-dispatch-execution.js";
import * as dispatchReceipt from "./terminal-dispatch-receipt.js";
import { positiveMilliseconds } from "./cli-command-runtime.js";
import { cliNow } from "./cli-runtime-context.js";
import type {
  TerminalCommandCliOptions,
  TerminalDispatchRecord
} from "./terminal-command-cli-ports.js";
import {
  TerminalSubmissionRetryReconciliation,
  type TerminalSubmissionRetryDeferredContext
} from "./terminal-submission-retry-reconciliation.js";
import type { TerminalSubmissionRetryTransportPorts } from
  "./terminal-submission-retry-ports.js";

const DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS = 5000;
const DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS = 50;
const terminalBridgeSubmission = dispatchReceipt.terminalBridgeSubmission;

export class TerminalSubmissionRetryTransport {
  constructor(
    private readonly ports: TerminalSubmissionRetryTransportPorts,
    private readonly reconciliation: TerminalSubmissionRetryReconciliation
  ) {}

  async runTerminalSubmissionExactDraftEnter(input: {
    options: TerminalCommandCliOptions;
    bridge: TerminalAgentBridge;
    execution: TerminalDispatchExecutionService;
    conversation: Conversation;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
    requestText: string;
    requestHash: string;
    originalMessageId: string;
    activeMessageId: string;
    terminalControl: TerminalControlRef;
    storeDir: string;
    statePath: string;
    logPath: string;
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
    attempt?: TerminalSubmissionRetryRecord;
    deferred?: TerminalSubmissionRetryDeferredContext;
  }): Promise<void> {
    let attempt = input.attempt;
    const reserveEnter = (): void => {
      this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
        statePath: input.statePath,
        exactTurnId: turnIdForConversation(input.conversation)
      });
      const at = cliNow().toISOString();
      const persistAttemptLedger = (): void => {
        this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
          ...this.ports.mutationDispatchLedger.load(input.scopes, input.resources),
          ...terminalSubmissionRetryLedgerFields(attempt)
        });
      };
      const advanceDeferred = (
        stage: "text_injected" | "enter_reserved",
        stageAt: string
      ): void => {
        if (!input.deferred || !attempt) return;
        input.deferred.transfer = this.ports.deferredForegroundApplication(
          input.options,
          input.deferred.boundary.terminal
        ).advanceSubmissionRetry({
          scope: input.deferred.scope,
          boundary: deferredForegroundBoundaryProjection(
            input.deferred.boundary
          ),
          attemptId: attempt.attempt_id,
          messageId: attempt.active_message_id,
          stage,
          at: stageAt
        });
      };
      if (!attempt) {
        attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
          ...this.reconciliation.terminalSubmissionRetryBaseRecord({
            mode: "exact_draft_enter",
            state: "enter_reserved",
            attemptId: `submission-retry-${randomUUID()}`,
            storeDir: input.storeDir,
            statePath: input.statePath,
            conversation: input.conversation,
            originalMessageId: input.originalMessageId,
            activeMessageId: input.activeMessageId,
            requestHash: input.requestHash,
            terminalControl: input.terminalControl,
            at,
            deferredTransferId: input.deferred?.transfer.transfer_id
          }),
          enter_reserved_at: at
        }, null);
        if (input.deferred) {
          input.deferred.transfer = this.ports.deferredForegroundApplication(
            input.options,
            input.deferred.boundary.terminal
          ).reserveSubmissionRetry({
            scope: input.deferred.scope,
            boundary: deferredForegroundBoundaryProjection(
              input.deferred.boundary
            ),
            attemptId: attempt.attempt_id,
            mode: attempt.mode,
            messageId: attempt.active_message_id,
            preparedAt: this.ports.required(
              stringValue(input.submission.prepared_at),
              "deferred retry prepared timestamp is unavailable"
            )
          });
        }
        advanceDeferred("enter_reserved", at);
        persistAttemptLedger();
        return;
      }
      if (
        attempt.mode === "replacement_send" &&
        attempt.state === "replacement_text_reserved"
      ) {
        attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
          ...attempt,
          state: "replacement_text_injected",
          replacement_text_injected_at: at,
          updated_at: at
        }, attempt.revision);
        advanceDeferred("text_injected", at);
        persistAttemptLedger();
      }
      if (attempt.state !== "replacement_text_injected") {
        throw new Error(
          "submission retry Enter is no longer reservable; no key was sent"
        );
      }
      const enterReservedAt = cliNow().toISOString();
      attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...attempt,
        state: "enter_reserved",
        enter_reserved_at: enterReservedAt,
        updated_at: enterReservedAt
      }, attempt.revision);
      advanceDeferred("enter_reserved", enterReservedAt);
      persistAttemptLedger();
    };
    await input.bridge.submitExactCodexDraft(
      input.terminalControl,
      input.requestText,
      {
        runtime: this.ports.terminalRuntimeIdentityForConversation(
          input.conversation,
          input.terminalControl
        ),
        beforeEnterReservation: reserveEnter
      }
    );
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (!attempt || attempt.state !== "enter_reserved") {
      throw new Error(
        "terminal bridge dispatched Enter without a durable retry reservation"
      );
    }
    const enterAt = cliNow().toISOString();
    attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
      ...attempt,
      state: "enter_dispatched",
      enter_dispatched_at: enterAt,
      updated_at: enterAt
    }, attempt.revision);
    if (input.deferred) {
      input.deferred.transfer = this.ports.deferredForegroundApplication(
        input.options,
        input.deferred.boundary.terminal
      ).advanceSubmissionRetry({
        scope: input.deferred.scope,
        boundary: deferredForegroundBoundaryProjection(
          input.deferred.boundary
        ),
        attemptId: attempt.attempt_id,
        messageId: attempt.active_message_id,
        stage: "enter_dispatched",
        at: enterAt
      });
    }
    const current = loadState(input.statePath);
    const currentSubmission = this.ports.required(
      terminalBridgeSubmission(current),
      "terminal submission receipt disappeared after retry Enter"
    );
    const enteredConversation = this.ports.withTerminalBridgeSubmission({
      conversation: this.reconciliation.withTerminalSubmissionRetryMonitorEpoch(
        this.reconciliation.terminalSubmissionRetryUnstalled(current),
        enterAt
      ),
      messageId: input.activeMessageId,
      messageType: this.reconciliation.terminalSubmissionRetryMessageType(currentSubmission),
      requestText: input.requestText,
      status: "enter_dispatched",
      preparedAt: this.ports.required(
        stringValue(currentSubmission.prepared_at),
        "terminal submission retry prepared timestamp is unavailable"
      ),
      textInjectedAt:
        stringValue(currentSubmission.text_injected_at) ??
          attempt.replacement_text_injected_at ?? attempt.reserved_at,
      enterDispatchedAt: enterAt,
      lastProvenStage: "enter_dispatched"
    });
    saveState(input.statePath, enteredConversation);
    let enteredLedger = {
      ...this.ports.mutationDispatchLedger.load(input.scopes, input.resources),
      ...terminalSubmissionRetryLedgerFields(attempt),
      status: "enter_dispatched",
      text_injected_at:
        stringValue(currentSubmission.text_injected_at) ??
          attempt.replacement_text_injected_at ?? attempt.reserved_at,
      enter_dispatched_at: enterAt,
      dispatcher_pid: null
    };
    this.ports.mutationDispatchLedger.save(input.scopes, input.resources, enteredLedger);
    appendEvent(input.logPath, {
      ts: enterAt,
      conversation_id: enteredConversation.conversation_id,
      event: "terminal_submission_retry_enter_dispatched",
      message_id: input.activeMessageId,
      terminal_input_sent: true
    });
    if (input.deferred) {
      const transfer = input.deferred.scope.loadTransfer(
        input.deferred.transfer.transfer_id
      );
      const recovered = await deferredRecoveryAdapter
        .recoverAcceptedDeferredForegroundDispatch(
          this.ports.deferredForegroundRecoveryAdapterPorts(),
          {
            options: input.options,
            scope: input.deferred.scope,
            storeDir: input.storeDir,
            terminal: input.deferred.boundary.terminal,
            transfer,
            boundary: input.deferred.boundary
          }
      );
      this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
        statePath: input.statePath,
        exactTurnId: turnIdForConversation(input.conversation)
      });
      if (recovered) {
        const finalized = this.reconciliation.finalizeDeferredTerminalSubmissionRetryAccepted({
          statePath: input.statePath,
          scopes: input.scopes,
          resources: input.resources,
          attempt
        });
        attempt = this.ports.required(
          finalized.attempt,
          "deferred retry attempt disappeared after accepted finalization"
        );
        const acceptedConversation = finalized.conversation;
        this.ports.startTerminalBridgeMonitorForConversation({
          conversation: acceptedConversation,
          statePath: input.statePath,
          logPath: input.logPath,
          options: input.options
        });
        this.reconciliation.printTerminalSubmissionRetryOutcome({
          conversation: acceptedConversation,
          terminalControl: input.terminalControl,
          attempt,
          outcome: "agent_accepted",
          terminalInputSent: true,
          reason: "The exact deferred Codex draft was submitted once and its transfer and source/target Sessions were committed."
        });
        return;
      }
      this.ports.startTerminalBridgeMonitorForConversation({
        conversation: enteredConversation,
        statePath: input.statePath,
        logPath: input.logPath,
        options: input.options
      });
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: enteredConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "enter_dispatched",
        terminalInputSent: true,
        reason: "The exact deferred Codex draft received one Enter; dedicated transfer acceptance remains pending and another retry is forbidden."
      });
      return;
    }
    const timeoutMs = positiveMilliseconds(
      input.options.terminalAcceptanceTimeoutMs ??
        DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
      "--terminal-acceptance-timeout-ms"
    );
    const acceptance = await input.execution.pollAcceptance({
      executor: "codex",
      conversation: enteredConversation,
      terminalControl: input.terminalControl,
      ...this.ports.terminalAcceptanceCompanionFences(
        enteredConversation,
        input.terminalControl
      ),
      timeoutMs,
      pollIntervalMs: Math.max(10, Math.min(
        timeoutMs,
        Number(input.options.terminalAcceptancePollIntervalMs ??
          DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS)
      )),
      scrollbackLines: Number(input.options.scrollbackLines ?? 240)
    });
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (acceptance.outcome === "agent_accepted") {
      const repaired = this.reconciliation.terminalSubmissionRetryAccepted({
        conversation: enteredConversation,
        submission: this.ports.required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after retry acceptance"
        ),
        ledger: enteredLedger,
        evidence: acceptance.evidence,
        requestText: input.requestText,
        at: cliNow().toISOString(),
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        terminalInputSent: true
      });
      this.ports.startTerminalBridgeMonitorForConversation({
        conversation: repaired.conversation,
        statePath: input.statePath,
        logPath: input.logPath,
        options: input.options
      });
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: repaired.conversation,
        terminalControl: input.terminalControl,
        attempt: repaired.attempt,
        outcome: "agent_accepted",
        terminalInputSent: true,
        reason: "The exact existing Codex draft was submitted once and native acceptance was proven."
      });
      return;
    }
    if (acceptance.outcome === "not_accepted") {
      const notAcceptedAt = cliNow().toISOString();
      const notAcceptedConversation = this.reconciliation.terminalSubmissionRetryTerminalOutcome({
        conversation: enteredConversation,
        submission: this.ports.required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after retry rejection"
        ),
        ledger: enteredLedger,
        requestText: input.requestText,
        reason: acceptance.reason,
        at: notAcceptedAt,
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        outcome: "not_accepted"
      });
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: notAcceptedConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "not_accepted",
        terminalInputSent: true,
        reason: "The exact draft remains in the Codex composer after one Enter; it was durably recorded as not accepted and another retry is forbidden."
      });
      return;
    }
    if (acceptance.outcome === "uncertain") {
      const uncertainConversation = this.reconciliation.terminalSubmissionRetryTerminalOutcome({
        conversation: enteredConversation,
        submission: this.ports.required(
          terminalBridgeSubmission(enteredConversation),
          "terminal submission receipt disappeared after uncertain retry acceptance"
        ),
        ledger: enteredLedger,
        requestText: input.requestText,
        reason: acceptance.reason,
        at: cliNow().toISOString(),
        statePath: input.statePath,
        logPath: input.logPath,
        scopes: input.scopes,
        resources: input.resources,
        attempt,
        outcome: "uncertain"
      });
      this.reconciliation.printTerminalSubmissionRetryOutcome({
        conversation: uncertainConversation,
        terminalControl: input.terminalControl,
        attempt,
        outcome: "refused",
        terminalInputSent: true,
        reason: `Exact-draft acceptance is uncertain (${acceptance.reason}); the terminal outcome is durable and another retry is forbidden.`
      });
      return;
    }
    this.ports.startTerminalBridgeMonitorForConversation({
      conversation: enteredConversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: enteredConversation,
      terminalControl: input.terminalControl,
      attempt,
      outcome: "enter_dispatched",
      terminalInputSent: true,
      reason: "The exact existing Codex draft received one Enter; acceptance remains pending and another retry is forbidden."
    });
  }

  async runTerminalSubmissionReplacement(input: {
    options: TerminalCommandCliOptions;
    bridge: TerminalAgentBridge;
    execution: TerminalDispatchExecutionService;
    observation: TerminalCodexComposerObservation;
    decision: Extract<TerminalSubmissionRetryDecision, {
      action: "start_replacement" | "resume_replacement";
    }>;
    conversation: Conversation;
    submission: TerminalDispatchRecord;
    ledger: TerminalDispatchLedgerDocument;
    requestText: string;
    requestHash: string;
    originalMessageId: string;
    terminalControl: TerminalControlRef;
    storeDir: string;
    statePath: string;
    logPath: string;
    scopes: CanonicalStateMutationScopes;
    resources: CanonicalStateMutationResources;
    attempt?: TerminalSubmissionRetryRecord;
    deferred?: TerminalSubmissionRetryDeferredContext;
  }): Promise<void> {
    if (input.observation.state !== "exact_empty") {
      throw new Error(
        "replacement send lost its positive empty-composer proof; no terminal input was sent"
      );
    }
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    let attempt = input.attempt;
    if (!attempt) {
      const at = cliNow().toISOString();
      attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath,
        this.reconciliation.terminalSubmissionRetryBaseRecord({
          mode: "replacement_send",
          state: "replacement_reserved",
          attemptId: `submission-retry-${randomUUID()}`,
          storeDir: input.storeDir,
          statePath: input.statePath,
          conversation: input.conversation,
          originalMessageId: input.originalMessageId,
          activeMessageId: input.originalMessageId,
          requestHash: input.requestHash,
          terminalControl: input.terminalControl,
          at,
          deferredTransferId: input.deferred?.transfer.transfer_id
        }), null);
      if (input.deferred) {
        input.deferred.transfer = this.ports.deferredForegroundApplication(
          input.options,
          input.deferred.boundary.terminal
        ).reserveSubmissionRetry({
          scope: input.deferred.scope,
          boundary: deferredForegroundBoundaryProjection(
            input.deferred.boundary
          ),
          attemptId: attempt.attempt_id,
          mode: attempt.mode,
          messageId: attempt.active_message_id,
          preparedAt: this.ports.required(
            stringValue(input.submission.prepared_at),
            "deferred retry prepared timestamp is unavailable"
            )
          });
      }
      const reservedLedger = this.ports.required(
        this.ports.mutationDispatchLedger.load(input.scopes, input.resources),
        "terminal submission retry ledger disappeared after reservation"
      );
      this.ports.mutationDispatchLedger.save(input.scopes, input.resources, {
        ...reservedLedger,
        ...terminalSubmissionRetryLedgerFields(attempt)
      });
    }
    if (
      attempt.mode !== "replacement_send" ||
      attempt.state !== "replacement_reserved"
    ) {
      throw new Error(
        "replacement text transport was already reserved; no additional text was sent"
      );
    }
    const currentAttempt = (): TerminalSubmissionRetryRecord => this.ports.required(
      attempt,
      "terminal submission retry attempt is unavailable"
    );
    const saveAttempt = (
      state: TerminalSubmissionRetryRecord["state"],
      at: string,
      fields: Partial<TerminalSubmissionRetryRecord>
    ): void => {
      const current = currentAttempt();
      attempt = this.reconciliation.saveTerminalSubmissionRetryForOpenTurn(input.statePath, {
        ...current,
        ...fields,
        state,
        updated_at: at
      }, current.revision);
    };
    const persistRetryLedger = (
      fields: Record<string, unknown> = {}
    ): TerminalDispatchLedgerDocument => {
      const current = this.ports.required(
        this.ports.mutationDispatchLedger.load(input.scopes, input.resources),
        "terminal submission retry ledger disappeared"
      );
      const next = {
        ...current,
        ...terminalSubmissionRetryLedgerFields(attempt),
        ...fields
      };
      this.ports.mutationDispatchLedger.save(input.scopes, input.resources, next);
      return next;
    };
    let enteredConversation: Conversation | undefined;
    let enteredLedger: TerminalDispatchLedgerDocument | undefined;
    await input.bridge.send(
      "codex",
      input.terminalControl,
      input.requestText,
      {
        runtime: this.ports.terminalRuntimeIdentityForConversation(
          input.conversation,
          input.terminalControl
        ),
        requireExactComposerBeforeEnter: true,
        requireExactEmptyComposerAfterBeforeText: {
          preliminaryComposerDigest: input.observation.digest
        },
        beforeText: () => {
          this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
            statePath: input.statePath,
            exactTurnId: turnIdForConversation(input.conversation)
          });
          const at = cliNow().toISOString();
          saveAttempt("replacement_text_reserved", at, {
            replacement_text_reserved_at: at
          });
          if (input.deferred) {
            input.deferred.transfer = this.ports.deferredForegroundApplication(
              input.options,
              input.deferred.boundary.terminal
            ).advanceSubmissionRetry({
              scope: input.deferred.scope,
              boundary: deferredForegroundBoundaryProjection(
                input.deferred.boundary
              ),
              attemptId: currentAttempt().attempt_id,
              messageId: currentAttempt().active_message_id,
              stage: "text_reserved",
              at
            });
          }
          persistRetryLedger();
        },
        beforeEnter: () => {
          this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
            statePath: input.statePath,
            exactTurnId: turnIdForConversation(input.conversation)
          });
          const at = cliNow().toISOString();
          saveAttempt("enter_reserved", at, { enter_reserved_at: at });
          if (input.deferred) {
            input.deferred.transfer = this.ports.deferredForegroundApplication(
              input.options,
              input.deferred.boundary.terminal
            ).advanceSubmissionRetry({
              scope: input.deferred.scope,
              boundary: deferredForegroundBoundaryProjection(
                input.deferred.boundary
              ),
              attemptId: currentAttempt().attempt_id,
              messageId: currentAttempt().active_message_id,
              stage: "enter_reserved",
              at
            });
          }
          persistRetryLedger();
        },
        onTransportStage: ({ stage }) => {
          this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
            statePath: input.statePath,
            exactTurnId: turnIdForConversation(input.conversation)
          });
          const at = cliNow().toISOString();
          if (stage === "text_injected") {
            saveAttempt("replacement_text_injected", at, {
              replacement_text_injected_at: at
            });
          } else {
            saveAttempt("enter_dispatched", at, {
              enter_dispatched_at: at
            });
          }
          if (input.deferred) {
            input.deferred.transfer = this.ports.deferredForegroundApplication(
              input.options,
              input.deferred.boundary.terminal
            ).advanceSubmissionRetry({
              scope: input.deferred.scope,
              boundary: deferredForegroundBoundaryProjection(
                input.deferred.boundary
              ),
              attemptId: currentAttempt().attempt_id,
              messageId: currentAttempt().active_message_id,
              stage,
              at
            });
          }
          if (stage === "text_injected") {
            persistRetryLedger();
            return;
          }
          const current = loadState(input.statePath);
          const submission = this.ports.required(
            terminalBridgeSubmission(current),
            "terminal submission receipt disappeared after replacement Enter"
          );
          enteredConversation = this.ports.withTerminalBridgeSubmission({
            conversation: this.reconciliation.withTerminalSubmissionRetryMonitorEpoch(
              this.reconciliation.terminalSubmissionRetryUnstalled(current),
              at
            ),
            messageId: input.originalMessageId,
            messageType: this.reconciliation.terminalSubmissionRetryMessageType(submission),
            requestText: input.requestText,
            status: "enter_dispatched",
            preparedAt: this.ports.required(
              stringValue(submission.prepared_at),
              "terminal submission retry prepared timestamp is unavailable"
            ),
            textInjectedAt: currentAttempt().replacement_text_injected_at as string,
            enterDispatchedAt: at,
            lastProvenStage: "enter_dispatched"
          });
          saveState(input.statePath, enteredConversation);
          enteredLedger = persistRetryLedger({
            status: "enter_dispatched",
            text_injected_at: currentAttempt().replacement_text_injected_at,
            enter_dispatched_at: at,
            enter_not_attempted_at: undefined,
            enter_not_attempted_reason: undefined,
            uncertain_at: undefined,
            safe_to_retry: undefined,
            acceptance_evidence: undefined,
            agent_accepted_at: undefined,
            not_accepted_at: undefined,
            dispatcher_pid: null
          });
          appendEvent(input.logPath, {
            ts: at,
            conversation_id: enteredConversation.conversation_id,
            event: "terminal_submission_retry_enter_dispatched",
            message_id: input.originalMessageId,
            terminal_input_sent: true
          });
        }
      }
    );
    this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
      statePath: input.statePath,
      exactTurnId: turnIdForConversation(input.conversation)
    });
    if (
      currentAttempt().state !== "enter_dispatched" ||
      !enteredConversation || !enteredLedger
    ) {
      throw new Error(
        "replacement transport returned without durable Enter evidence"
      );
    }
    if (input.deferred) {
      const transfer = input.deferred.scope.loadTransfer(
        input.deferred.transfer.transfer_id
      );
      const recovered = await deferredRecoveryAdapter
        .recoverAcceptedDeferredForegroundDispatch(
          this.ports.deferredForegroundRecoveryAdapterPorts(),
          {
            options: input.options,
            scope: input.deferred.scope,
            storeDir: input.storeDir,
            terminal: input.deferred.boundary.terminal,
            transfer,
            boundary: input.deferred.boundary
          }
      );
      this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
        statePath: input.statePath,
        exactTurnId: turnIdForConversation(input.conversation)
      });
      if (recovered) {
        const finalized = this.reconciliation.finalizeDeferredTerminalSubmissionRetryAccepted({
          statePath: input.statePath,
          scopes: input.scopes,
          resources: input.resources,
          attempt
        });
        attempt = this.ports.required(
          finalized.attempt,
          "deferred replacement retry attempt disappeared after accepted finalization"
        );
        const acceptedConversation = finalized.conversation;
        this.ports.startTerminalBridgeMonitorForConversation({
          conversation: acceptedConversation,
          statePath: input.statePath,
          logPath: input.logPath,
          options: input.options
        });
        this.reconciliation.printTerminalSubmissionRetryOutcome({
          conversation: acceptedConversation,
          terminalControl: input.terminalControl,
          attempt,
          outcome: "agent_accepted",
          terminalInputSent: true,
          reason: "The missing deferred Codex submission was completed once and its source/target Sessions were committed."
        });
        return;
      }
    } else {
      const timeoutMs = positiveMilliseconds(
        input.options.terminalAcceptanceTimeoutMs ??
          DEFAULT_TERMINAL_ACCEPTANCE_TIMEOUT_MS,
        "--terminal-acceptance-timeout-ms"
      );
      const acceptance = await input.execution.pollAcceptance({
        executor: "codex",
        conversation: enteredConversation,
        terminalControl: input.terminalControl,
        ...this.ports.terminalAcceptanceCompanionFences(
          enteredConversation,
          input.terminalControl
        ),
        timeoutMs,
        pollIntervalMs: Math.max(10, Math.min(
          timeoutMs,
          Number(input.options.terminalAcceptancePollIntervalMs ??
            DEFAULT_TERMINAL_ACCEPTANCE_POLL_INTERVAL_MS)
        )),
        scrollbackLines: Number(input.options.scrollbackLines ?? 240)
      });
      this.reconciliation.assertTerminalSubmissionRetryTurnOpen({
        statePath: input.statePath,
        exactTurnId: turnIdForConversation(input.conversation)
      });
      if (acceptance.outcome === "agent_accepted") {
        const repaired = this.reconciliation.terminalSubmissionRetryAccepted({
          conversation: enteredConversation,
          submission: this.ports.required(
            terminalBridgeSubmission(enteredConversation),
            "terminal submission receipt disappeared after replacement acceptance"
          ),
          ledger: enteredLedger,
          evidence: acceptance.evidence,
          requestText: input.requestText,
          at: cliNow().toISOString(),
          statePath: input.statePath,
          logPath: input.logPath,
          scopes: input.scopes,
          resources: input.resources,
          attempt,
          terminalInputSent: true
        });
        this.ports.startTerminalBridgeMonitorForConversation({
          conversation: repaired.conversation,
          statePath: input.statePath,
          logPath: input.logPath,
          options: input.options
        });
        this.reconciliation.printTerminalSubmissionRetryOutcome({
          conversation: repaired.conversation,
          terminalControl: input.terminalControl,
          attempt: repaired.attempt,
          outcome: "agent_accepted",
          terminalInputSent: true,
          reason: "The missing Codex submission was completed once and native acceptance was proven."
        });
        return;
      }
      if (acceptance.outcome === "not_accepted") {
        const notAcceptedConversation = this.reconciliation.terminalSubmissionRetryTerminalOutcome({
          conversation: enteredConversation,
          submission: this.ports.required(
            terminalBridgeSubmission(enteredConversation),
            "terminal submission receipt disappeared after replacement rejection"
          ),
          ledger: enteredLedger,
          requestText: input.requestText,
          reason: acceptance.reason,
          at: cliNow().toISOString(),
          statePath: input.statePath,
          logPath: input.logPath,
          scopes: input.scopes,
          resources: input.resources,
          attempt,
          outcome: "not_accepted"
        });
        this.reconciliation.printTerminalSubmissionRetryOutcome({
          conversation: notAcceptedConversation,
          terminalControl: input.terminalControl,
          attempt,
          outcome: "not_accepted",
          terminalInputSent: true,
          reason: "The replacement text remains in the Codex composer after one Enter; it was not accepted and another retry is forbidden."
        });
        return;
      }
      if (acceptance.outcome === "uncertain") {
        const uncertainConversation = this.reconciliation.terminalSubmissionRetryTerminalOutcome({
          conversation: enteredConversation,
          submission: this.ports.required(
            terminalBridgeSubmission(enteredConversation),
            "terminal submission receipt disappeared after uncertain replacement acceptance"
          ),
          ledger: enteredLedger,
          requestText: input.requestText,
          reason: acceptance.reason,
          at: cliNow().toISOString(),
          statePath: input.statePath,
          logPath: input.logPath,
          scopes: input.scopes,
          resources: input.resources,
          attempt,
          outcome: "uncertain"
        });
        this.reconciliation.printTerminalSubmissionRetryOutcome({
          conversation: uncertainConversation,
          terminalControl: input.terminalControl,
          attempt,
          outcome: "refused",
          terminalInputSent: true,
          reason: `Replacement acceptance is uncertain (${acceptance.reason}); another retry is forbidden.`
        });
        return;
      }
    }
    this.ports.startTerminalBridgeMonitorForConversation({
      conversation: enteredConversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    this.reconciliation.printTerminalSubmissionRetryOutcome({
      conversation: enteredConversation,
      terminalControl: input.terminalControl,
      attempt,
      outcome: "enter_dispatched",
      terminalInputSent: true,
      reason: "The missing Codex submission received one text injection and one Enter; acceptance remains pending and another retry is forbidden."
    });
  }

}

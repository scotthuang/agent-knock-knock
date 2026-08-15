import type { ExecutorKind } from "./executors.js";
import { isExactNativeThreadId } from "./managed-session.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  exactRolloutMatches,
  isCompleteNativeRollout,
  type TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import type { VirginBindingRecoveryState } from
  "./terminal-acceptance-application-service.js";

export interface VirginCodexSessionBindingFacts {
  bindingId?: string;
  generation?: number;
  pid?: number;
  terminalIncarnationMatches: boolean;
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: TerminalNativeIdentity["rollout"];
}

export interface VirginCodexRecoveryFacts {
  agent: ExecutorKind;
  anchorVersion?: number;
  anchorNativeThreadBinding?: string;
  anchorProcessUuid?: string;
  anchorProcessBirth?: string;
  terminalControl?: TerminalControlRef;
  initialTerminalIncarnationMatches: boolean;
  submissionStatus?: string;
  messageId?: string;
  takeoverMessageId?: string;
  requestHash?: string;
  computedRequestHash?: string;
  bindingId?: string;
  bindingGeneration?: number;
  pid?: number;
  sessionId?: string;
  sessionAgent?: ExecutorKind;
  sessionStatus?: string;
  sessionBinding?: VirginCodexSessionBindingFacts;
  turnNativeThreadId?: string;
  turnProcessUuid?: string;
  turnProcessBirth?: string;
  turnRollout?: TerminalNativeIdentity["rollout"];
}

export interface PersistedVirginIdentityProof {
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: TerminalNativeIdentity["rollout"];
}

export interface ManagedTurnRecoveryPorts {
  identity: {
    resolve(input: {
      pid: number;
      cwd?: string;
      preferredSessionId?: string;
    }): Promise<TerminalNativeIdentity | undefined>;
  };
  acceptance: {
    detect(identity: TerminalNativeIdentity, requestHash: string): boolean;
  };
  authority: {
    assertExclusive(input: {
      pid: number;
      nativeThreadId: string;
      terminalControl: TerminalControlRef;
      sessionId: string;
    }): Promise<void>;
    assertTurn(identity?: TerminalNativeIdentity): void;
  };
  persistence: {
    persistSessionIdentity(
      identity: TerminalNativeIdentity
    ): PersistedVirginIdentityProof | undefined;
    persistTurnIdentity(identity: TerminalNativeIdentity): void;
  };
}

export interface ManagedTurnRecoveryResult {
  state: VirginBindingRecoveryState;
  identity?: TerminalNativeIdentity;
}

const RECOVERABLE_SUBMISSION_STATUSES = new Set([
  "enter_dispatched",
  "agent_accepted"
]);

export function isVirginCodexRecoveryCandidate(
  facts: VirginCodexRecoveryFacts
): boolean {
  return facts.agent === "codex" &&
    facts.anchorVersion === 2 &&
    facts.anchorNativeThreadBinding === "post_submission" &&
    facts.terminalControl !== undefined &&
    RECOVERABLE_SUBMISSION_STATUSES.has(facts.submissionStatus ?? "");
}

export function isCurrentVirginCodexRecoveryBoundary(
  facts: VirginCodexRecoveryFacts
): boolean {
  return isVirginCodexRecoveryCandidate(facts) &&
    facts.initialTerminalIncarnationMatches &&
    Boolean(facts.messageId) &&
    facts.messageId === facts.takeoverMessageId &&
    Boolean(facts.requestHash) &&
    facts.requestHash === facts.computedRequestHash;
}

/**
 * Recovers one split post-submission Session/Turn identity transaction. The
 * service sees only literal facts and typed capability ports, never Store,
 * filesystem, lock, JSON, or terminal-adapter instances.
 */
export class ManagedTurnRecoveryService {
  readonly #ports: ManagedTurnRecoveryPorts;

  constructor(ports: ManagedTurnRecoveryPorts) {
    this.#ports = ports;
  }

  async recover(
    facts: VirginCodexRecoveryFacts
  ): Promise<ManagedTurnRecoveryResult> {
    if (!isVirginCodexRecoveryCandidate(facts)) {
      return { state: "not_applicable" };
    }
    const terminalControl = facts.terminalControl as TerminalControlRef;
    const binding = facts.sessionBinding;
    if (!this.#hasCurrentTransactionAuthority(facts, binding)) {
      throw new Error(
        "virgin Codex post-submission binding changed before recovery"
      );
    }
    this.#assertProcessAuthority(facts, binding as VirginCodexSessionBindingFacts);

    const turnNativeThreadId = facts.turnNativeThreadId;
    const sessionNativeThreadId = binding?.nativeThreadId;
    this.#assertCompatibleDurableIdentities(
      facts,
      binding as VirginCodexSessionBindingFacts
    );
    if (turnNativeThreadId && sessionNativeThreadId) {
      this.#ports.authority.assertTurn();
      return { state: "already_bound" };
    }

    const preferredSessionId = turnNativeThreadId ?? sessionNativeThreadId;
    const identity = await this.#ports.identity.resolve({
      pid: facts.pid as number,
      cwd: terminalControl.currentPath,
      preferredSessionId
    });
    if (!identity) {
      return { state: "pending" };
    }
    this.#assertResolvedIdentity(
      facts,
      binding as VirginCodexSessionBindingFacts,
      identity,
      preferredSessionId
    );
    if (
      !turnNativeThreadId &&
      !sessionNativeThreadId &&
      !this.#ports.acceptance.detect(identity, facts.requestHash as string)
    ) {
      return { state: "pending" };
    }

    await this.#ports.authority.assertExclusive({
      pid: facts.pid as number,
      nativeThreadId: identity.sessionId,
      terminalControl,
      sessionId: facts.sessionId as string
    });
    if (!sessionNativeThreadId) {
      const proof = this.#ports.persistence.persistSessionIdentity(identity);
      this.#assertPersistedSessionIdentity(proof, identity);
    }
    if (!turnNativeThreadId) {
      this.#ports.persistence.persistTurnIdentity(identity);
    }
    this.#ports.authority.assertTurn(identity);
    return { state: "recovered", identity };
  }

  #hasCurrentTransactionAuthority(
    facts: VirginCodexRecoveryFacts,
    binding: VirginCodexSessionBindingFacts | undefined
  ): boolean {
    return facts.initialTerminalIncarnationMatches &&
      Boolean(facts.messageId) &&
      facts.messageId === facts.takeoverMessageId &&
      RECOVERABLE_SUBMISSION_STATUSES.has(facts.submissionStatus ?? "") &&
      Boolean(facts.requestHash) &&
      facts.requestHash === facts.computedRequestHash &&
      Boolean(facts.bindingId) &&
      Number.isSafeInteger(facts.bindingGeneration) &&
      Number.isSafeInteger(facts.pid) &&
      (facts.pid as number) > 1 &&
      Boolean(facts.sessionId) &&
      facts.sessionAgent === "codex" &&
      facts.sessionStatus === "bound" &&
      binding !== undefined &&
      binding.bindingId === facts.bindingId &&
      binding.generation === facts.bindingGeneration &&
      binding.pid === facts.pid &&
      binding.terminalIncarnationMatches;
  }

  #assertProcessAuthority(
    facts: VirginCodexRecoveryFacts,
    binding: VirginCodexSessionBindingFacts
  ): void {
    if (
      !facts.anchorProcessUuid ||
      !facts.anchorProcessBirth ||
      facts.turnProcessUuid !== facts.anchorProcessUuid ||
      facts.turnProcessBirth !== facts.anchorProcessBirth ||
      binding.processUuid !== facts.anchorProcessUuid ||
      binding.processBirth !== facts.anchorProcessBirth
    ) {
      throw new Error(
        "virgin Codex process incarnation changed before binding recovery"
      );
    }
  }

  #assertCompatibleDurableIdentities(
    facts: VirginCodexRecoveryFacts,
    binding: VirginCodexSessionBindingFacts
  ): void {
    if (
      facts.turnNativeThreadId &&
      binding.nativeThreadId &&
      facts.turnNativeThreadId !== binding.nativeThreadId
    ) {
      throw new Error(
        "virgin Codex Session and Turn disagree before binding recovery"
      );
    }
    if (facts.turnNativeThreadId && !isCompleteNativeRollout(facts.turnRollout)) {
      throw new Error(
        "virgin Codex Turn has a partial recovered native identity"
      );
    }
    if (binding.nativeThreadId && !isCompleteNativeRollout(binding.rollout)) {
      throw new Error(
        "virgin Codex Session has a partial recovered native identity"
      );
    }
  }

  #assertResolvedIdentity(
    facts: VirginCodexRecoveryFacts,
    binding: VirginCodexSessionBindingFacts,
    identity: TerminalNativeIdentity,
    preferredSessionId: string | undefined
  ): void {
    if (
      !isExactNativeThreadId(identity.sessionId) ||
      identity.processUuid !== facts.anchorProcessUuid ||
      identity.processBirth !== facts.anchorProcessBirth ||
      !isCompleteNativeRollout(identity.rollout) ||
      (preferredSessionId && identity.sessionId !== preferredSessionId) ||
      (facts.turnNativeThreadId &&
        !exactRolloutMatches(facts.turnRollout, identity.rollout)) ||
      (binding.nativeThreadId &&
        !exactRolloutMatches(binding.rollout, identity.rollout))
    ) {
      throw new Error(
        "virgin Codex native identity changed before binding recovery"
      );
    }
  }

  #assertPersistedSessionIdentity(
    proof: PersistedVirginIdentityProof | undefined,
    identity: TerminalNativeIdentity
  ): void {
    if (
      proof?.nativeThreadId !== identity.sessionId ||
      proof.processUuid !== identity.processUuid ||
      proof.processBirth !== identity.processBirth ||
      !exactRolloutMatches(proof.rollout, identity.rollout)
    ) {
      throw new Error(
        "virgin Codex Session identity was not durably committed during recovery"
      );
    }
  }
}

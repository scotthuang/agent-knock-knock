import type { ConversationStatus } from "./protocol.js";
import {
  legacyManagedSessionBindingToken,
  managedSessionBindingToken,
  type ManagedSessionState
} from "./managed-session.js";
import {
  type CanonicalMutationLockPorts,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  decideBindingReconciliation,
  type ManagedBindingConflictKind
} from "./native-thread-transition-policy.js";
import type { ExecutorKind } from "./executors.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalNativeIdentity } from "./terminal-binding-authority.js";

export interface BindingReconciliationTerminalFacts {
  readonly conversationId: string;
  readonly agent: ExecutorKind;
  readonly pid: number;
  readonly terminalControl: TerminalControlRef;
}

export interface BindingReconciliationStatusFacts {
  readonly reachable: boolean;
  readonly activity_state: string;
  readonly activity_reason: string;
  readonly approval_state: Readonly<{ blocked: boolean }>;
}

type Identity = TerminalNativeIdentity | undefined;
type ScopeArgs = [CanonicalMutationScopes, CanonicalMutationResources];
type Scoped<Args extends unknown[], Result> = (...args: [...ScopeArgs, ...Args]) => Result;
type TurnBlocker = Readonly<{ turnId: string; status: ConversationStatus }>;
export type BindingReconciliationRequest<
  Terminal extends BindingReconciliationTerminalFacts =
    BindingReconciliationTerminalFacts
> = Readonly<{
  initialTerminal: Terminal;
  conflictingSessionId: string;
  expectedSessionRevision: number;
  expectedBindingToken: string;
  expectedTerminalToken: string;
}>;
export type BindingReconciliationResult<
  Terminal extends BindingReconciliationTerminalFacts =
    BindingReconciliationTerminalFacts
> = Readonly<{
  terminal: Terminal;
  detached: ManagedSessionState;
  conflictKind: ManagedBindingConflictKind;
}>;
type BindingTransactionPort<
  Terminal extends BindingReconciliationTerminalFacts
> = Readonly<{
  locks: CanonicalMutationLockPorts;
  recover: Scoped<[Terminal], Promise<void>>;
  loadSession: Scoped<[string], ManagedSessionState>;
  saveSession: Scoped<
    [ManagedSessionState, { expectedRevision: number }],
    ManagedSessionState
  >;
}>;
type BindingTerminalPort<
  Terminal extends BindingReconciliationTerminalFacts,
  Status extends BindingReconciliationStatusFacts
> = Readonly<{
  resolve: () => Promise<Terminal>;
  sameIncarnation: (left: unknown, right: unknown) => boolean;
  identity: (terminal: Terminal) => Promise<Identity>;
  prepareStatus: () => (
    terminal: Terminal
  ) => Promise<Status>;
  assertReady: (
    terminal: Terminal,
    status: Status
  ) => void;
}>;
type BindingAuthorityPort<
  Terminal extends BindingReconciliationTerminalFacts
> = Readonly<{
  dispatchIsFree: (control: Terminal["terminalControl"]) => boolean;
  sessionClaimsTerminal: (session: ManagedSessionState, terminal: Terminal) => boolean;
  terminalTokenMatches: (terminal: Terminal, identity: Identity, token: string) => boolean;
  hasUnresolvedTransition: (session: ManagedSessionState) => boolean;
  blockingTurn: (sessionId: string) => TurnBlocker | undefined;
  conflictKind: (
    session: ManagedSessionState, terminal: Terminal, identity: Identity
  ) => ManagedBindingConflictKind | undefined;
}>;
export type BindingReconciliationPorts<
  Terminal extends BindingReconciliationTerminalFacts =
    BindingReconciliationTerminalFacts,
  Status extends BindingReconciliationStatusFacts =
    BindingReconciliationStatusFacts
> = Readonly<{
  transaction: BindingTransactionPort<Terminal>;
  terminal: BindingTerminalPort<Terminal, Status>;
  authority: BindingAuthorityPort<Terminal>;
  now: () => string;
  present: (result: BindingReconciliationResult<Terminal>) => void;
}>;
const REJECTION_MESSAGES = {
  stale_process_incarnation: "the stale process incarnation no longer requires explicit reconciliation; refresh AKK list",
  already_exact: "the managed Session now exactly matches the live terminal; no reconciliation is needed",
  unverifiable: "the managed binding conflict is unverifiable and cannot be detached automatically"
} as const;
function requireCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
function sameTerminal<Terminal extends BindingReconciliationTerminalFacts>(
  port: Pick<
    BindingTerminalPort<Terminal, BindingReconciliationStatusFacts>,
    "sameIncarnation"
  >,
  candidate: Terminal,
  expected: Terminal
): boolean {
  return candidate.pid === expected.pid &&
    candidate.conversationId === expected.conversationId &&
    port.sameIncarnation(candidate.terminalControl, expected.terminalControl);
}
function sessionTokenMatches(session: ManagedSessionState, expected: string): boolean {
  return [
    managedSessionBindingToken(session),
    legacyManagedSessionBindingToken(session)
  ].includes(expected);
}
export async function reconcileTerminalBinding<
  Terminal extends BindingReconciliationTerminalFacts,
  Status extends BindingReconciliationStatusFacts
>(
  request: BindingReconciliationRequest<Terminal>,
  ports: BindingReconciliationPorts<Terminal, Status>
): Promise<void> {
  const { authority, terminal, transaction } = ports;
  return withCanonicalMutationLocks(transaction.locks, async (scopes, resources) => {
    const current = await terminal.resolve();
    requireCondition(sameTerminal(terminal, current, request.initialTerminal),
      "terminal identity changed while waiting to reconcile its binding; refresh AKK list");
    await transaction.recover(scopes, resources, current);
    requireCondition(authority.dispatchIsFree(current.terminalControl),
      "the terminal acquired an unresolved dispatch after the binding conflict was listed; refresh AKK list");
    const session = transaction.loadSession(scopes, resources, request.conflictingSessionId);
    requireCondition(session.revision === request.expectedSessionRevision &&
      sessionTokenMatches(session, request.expectedBindingToken),
    "managed Session binding changed after it was listed; refresh AKK list");
    requireCondition(authority.sessionClaimsTerminal(session, current),
      "the listed managed Session no longer claims this exact terminal");
    const identity = await terminal.identity(current);
    requireCondition(authority.terminalTokenMatches(current, identity, request.expectedTerminalToken),
      "live terminal identity changed after the conflict was listed; refresh AKK list");
    const readStatus = terminal.prepareStatus();
    requireCondition(!authority.hasUnresolvedTransition(session),
      `managed Session ${session.session_id} has an unresolved native-thread transition`);
    const blocker = authority.blockingTurn(session.session_id);
    if (blocker) {
      throw new Error(
        `managed Session ${session.session_id} still has unresolved Turn ` +
        `${blocker.turnId} (${blocker.status})`
      );
    }
    const finalTerminal = await terminal.resolve();
    requireCondition(sameTerminal(terminal, finalTerminal, current),
      "terminal identity changed during binding reconciliation; refresh AKK list");
    const finalStatus = await readStatus(finalTerminal);
    terminal.assertReady(finalTerminal, finalStatus);
    const finalIdentity = await terminal.identity(finalTerminal);
    requireCondition(authority.terminalTokenMatches(finalTerminal, finalIdentity,
      request.expectedTerminalToken), "live terminal identity changed during binding reconciliation; refresh AKK list");
    const finalSession = transaction.loadSession(scopes, resources, request.conflictingSessionId);
    requireCondition(finalSession.revision === request.expectedSessionRevision &&
      sessionTokenMatches(finalSession, request.expectedBindingToken),
    "managed Session binding changed during reconciliation; refresh AKK list");
    const conflictKind = authority.conflictKind(finalSession, finalTerminal, finalIdentity);
    const decision = decideBindingReconciliation(conflictKind);
    if (decision.action === "reject") {
      throw new Error(REJECTION_MESSAGES[decision.reason]);
    }
    const reconciledAt = ports.now();
    const detached = transaction.saveSession(scopes, resources, {
      ...finalSession,
      status: "detached",
      detached_at: reconciledAt,
      updated_at: reconciledAt
    }, { expectedRevision: request.expectedSessionRevision });
    ports.present({
      terminal: current,
      detached,
      conflictKind: conflictKind!
    });
  });
}

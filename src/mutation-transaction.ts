type Awaitable<Value> = Value | PromiseLike<Value>;
type ScopeKind = "terminal" | "storeWriter" | "state";
declare const mutationScopeBrand: unique symbol;

type MutationScope<Kind extends ScopeKind> = Readonly<{ [mutationScopeBrand]: Kind }>;
export type TerminalMutationScope = MutationScope<"terminal">;
export type StoreWriterMutationScope = MutationScope<"storeWriter">;
export type StateMutationScope = MutationScope<"state">;
export type CanonicalMutationScopes = Readonly<{
  terminal: TerminalMutationScope;
  storeWriter: StoreWriterMutationScope;
  state?: StateMutationScope;
}>;
export type CanonicalStateMutationScopes = CanonicalMutationScopes &
  Readonly<{ state: StateMutationScope }>;
export type CanonicalMutationLockPorts = Readonly<{
  acquireTerminal: () => Awaitable<() => void>;
  withStoreWriter: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  acquireState?: () => Awaitable<() => void>;
}>;

const scopeRecords = new WeakMap<object, Readonly<{ kind: ScopeKind; transaction: object }>>();

function createScope<Kind extends ScopeKind>(transaction: object, kind: Kind) {
  const value = Object.freeze({}) as MutationScope<Kind>;
  scopeRecords.set(value, { kind, transaction });
  return value;
}

function expireScope(scope: MutationScope<ScopeKind>): void { scopeRecords.delete(scope); }

function assertActiveScopes(scopes: Partial<CanonicalStateMutationScopes>, required: readonly ScopeKind[]): void {
  let transaction: object | undefined;
  for (const kind of required) {
    const record = scopes[kind] && scopeRecords.get(scopes[kind]);
    if (!record || record.kind !== kind) {
      throw new Error(`mutation repository requires active authentic ${kind} scope`);
    }
    if (transaction && transaction !== record.transaction) {
      throw new Error("mutation repository scopes belong to different transactions");
    }
    transaction = record.transaction;
  }
}

type ScopesFor<Kinds extends readonly ScopeKind[]> =
  Pick<CanonicalStateMutationScopes, Kinds[number]>;
export function capabilityGatedRepositoryOperation<
  const Required extends readonly ScopeKind[], Args extends unknown[], Result
>(required: Required, operation: (...args: Args) => Result) {
  const requiredScopes = Object.freeze([...required]);
  return (scopes: ScopesFor<Required>, ...args: Args): Result => {
    assertActiveScopes(scopes, requiredScopes);
    return operation(...args);
  };
}

type ScopesForPorts<Ports> = Ports extends { acquireState: () => unknown }
  ? CanonicalStateMutationScopes : CanonicalMutationScopes;
/** Acquire terminal -> writer -> optional state and release in reverse. */
export async function withCanonicalMutationLocks<Result, Ports extends CanonicalMutationLockPorts>(
  ports: Ports,
  operation: (scopes: ScopesForPorts<Ports>) => Promise<Result>
): Promise<Result> {
  const transaction = {};
  const releaseTerminal = await ports.acquireTerminal();
  const terminal = createScope(transaction, "terminal");
  try {
    return await ports.withStoreWriter(async () => {
      const storeWriter = createScope(transaction, "storeWriter");
      try {
        if (!ports.acquireState) {
          return await operation({ terminal, storeWriter } as ScopesForPorts<Ports>);
        }
        const releaseState = await ports.acquireState();
        const state = createScope(transaction, "state");
        try {
          return await operation({ terminal, storeWriter, state } as ScopesForPorts<Ports>);
        } finally {
          expireScope(state);
          releaseState();
        }
      } finally {
        expireScope(storeWriter);
      }
    });
  } finally {
    expireScope(terminal);
    releaseTerminal();
  }
}

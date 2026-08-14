type Awaitable<Value> = Value | PromiseLike<Value>;
type ScopeKind = "terminal" | "storeWriter" | "state";
export type CanonicalMutationResource<Value = unknown> = Readonly<{ key: string; value: Value }>;
type ScopeResources = Readonly<Record<ScopeKind, CanonicalMutationResource>>;
export type CanonicalMutationResources = Readonly<Pick<ScopeResources, "terminal" | "storeWriter"> & Partial<ScopeResources>>;
export type CanonicalStateMutationResources = Readonly<ScopeResources>;
declare const mutationScopeBrand: unique symbol;
type MutationScope<Kind extends ScopeKind> = Readonly<{ [mutationScopeBrand]: Kind }>;
export type CanonicalMutationScopes = Readonly<{
  terminal: MutationScope<"terminal">; storeWriter: MutationScope<"storeWriter">;
  state?: MutationScope<"state">;
}>;
export type CanonicalStateMutationScopes = CanonicalMutationScopes & Readonly<{ state: MutationScope<"state"> }>;
export type CanonicalMutationLockPorts = Readonly<{
  resources: CanonicalMutationResources;
  acquireTerminal: () => Awaitable<() => void>;
  withStoreWriter: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  acquireState?: () => Awaitable<() => void>;
}>;
const scopeRecords = new WeakMap<object, Readonly<{ kind: ScopeKind; transaction: object; resource: CanonicalMutationResource }>>();
export function canonicalMutationResource<Value>(key: string, value: Value) { return Object.freeze({ key, value }); }
function createScope<Kind extends ScopeKind>(transaction: object, kind: Kind, resource: CanonicalMutationResource) {
  const scope = Object.freeze({}) as MutationScope<Kind>;
  scopeRecords.set(scope, { kind, transaction, resource });
  return scope;
}
function expireScope(scope: MutationScope<ScopeKind>): void { scopeRecords.delete(scope); }
async function withAcquiredScope<Result, Kind extends ScopeKind>(
  transaction: object, kind: Kind, resource: CanonicalMutationResource, acquire: () => Awaitable<() => void>,
  operation: (scope: MutationScope<Kind>) => Promise<Result>
): Promise<Result> {
  const release = await acquire();
  const scope = createScope(transaction, kind, resource);
  try { return await operation(scope); }
  finally { expireScope(scope); release(); }
}
function assertActiveScopes(
  scopes: Partial<CanonicalStateMutationScopes>, resources: Partial<ScopeResources>,
  required: readonly ScopeKind[]): object {
  let transaction: object | undefined;
  for (const kind of required) {
    const record = scopes[kind] && scopeRecords.get(scopes[kind]);
    if (!record || record.kind !== kind || record.resource !== resources[kind]) {
      throw new Error(`mutation repository requires active authentic ${kind} scope`);
    }
    if (transaction && transaction !== record.transaction) {
      throw new Error("mutation repository scopes belong to different transactions");
    }
    transaction = record.transaction;
  }
  if (!transaction) {
    throw new Error("mutation repository requires at least one active scope");
  }
  return transaction;
}
type ScopesFor<Kinds extends readonly ScopeKind[]> = Pick<CanonicalStateMutationScopes, Kinds[number]>;
export function capabilityGatedRepositoryOperation<
  const Required extends readonly ScopeKind[], Bound extends Required[number], Resource, Args extends unknown[], Result>(
  required: Required, bound: Bound,
  operation: (resource: Resource, ...args: Args) => Result) {
  return (scopes: ScopesFor<Required>, resources: Pick<ScopeResources, Required[number]>, ...args: Args) => {
    assertActiveScopes(scopes, resources, required);
    return operation(resources[bound].value as Resource, ...args);
  };
}
export function capabilityGatedRepositoryPairOperation<
  const Required extends readonly ScopeKind[], First extends Required[number], Second extends Required[number],
  FirstResource, SecondResource, Args extends unknown[], Result>(required: Required, bound: readonly [First, Second],
  operation: (first: FirstResource, second: SecondResource, ...args: Args) => Result) {
  return (scopes: ScopesFor<Required>, resources: Pick<ScopeResources, Required[number]>, ...args: Args) => {
    assertActiveScopes(scopes, resources, required);
    return operation(
      resources[bound[0]].value as FirstResource,
      resources[bound[1]].value as SecondResource,
      ...args
    );
  };
}
type ScopesForPorts<Ports> = Ports extends { acquireState: () => unknown } ? CanonicalStateMutationScopes : CanonicalMutationScopes;
type ResourcesForPorts<Ports> = Ports extends { acquireState: () => unknown } ? ScopeResources : CanonicalMutationResources;
/** Acquire terminal -> writer -> optional state and release in reverse. */
export async function withCanonicalMutationLocks<Result, Ports extends CanonicalMutationLockPorts>(
  ports: Ports, operation: (
    scopes: ScopesForPorts<Ports>, resources: ResourcesForPorts<Ports>) => Promise<Result>
): Promise<Result> {
  const transaction = {};
  return withAcquiredScope(transaction, "terminal", ports.resources.terminal, ports.acquireTerminal, (terminal) =>
    ports.withStoreWriter(async () => {
      const storeWriter = createScope(transaction, "storeWriter", ports.resources.storeWriter);
      const invoke = (state?: MutationScope<"state">) => operation(
        { terminal, storeWriter, ...(state ? { state } : {}) } as ScopesForPorts<Ports>, ports.resources as ResourcesForPorts<Ports>
      );
      try {
        if (!ports.acquireState) return await invoke();
        const stateResource = ports.resources.state;
        if (!stateResource) throw new Error("state mutation lock requires a canonical resource");
        return await withAcquiredScope(transaction, "state", stateResource, ports.acquireState, invoke);
      } finally { expireScope(storeWriter); }
    }));
}

/** Add one state scope to the currently active terminal + writer transaction. */
export async function withCanonicalStateMutationLock<Result, StateResource>(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  state: Readonly<{
    resource: CanonicalMutationResource<StateResource>;
    acquire: () => Awaitable<() => void>;
  }>,
  operation: (
    scopes: CanonicalStateMutationScopes,
    resources: CanonicalStateMutationResources
  ) => Promise<Result>
): Promise<Result> {
  const transaction = assertActiveScopes(
    scopes,
    resources,
    ["terminal", "storeWriter"]
  );
  return withAcquiredScope(
    transaction,
    "state",
    state.resource,
    state.acquire,
    (stateScope) => operation(
      { ...scopes, state: stateScope },
      Object.freeze({ ...resources, state: state.resource }) as
        CanonicalStateMutationResources
    )
  );
}

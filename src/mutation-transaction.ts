/**
 * The mutation shell owns only lock nesting. Business state, durable writes,
 * terminal effects, and their ordering stay in the caller-supplied operation.
 */

type Awaitable<Value> = Value | PromiseLike<Value>;
type Release = () => void;

declare const terminalLockCapabilityBrand: unique symbol;
declare const storeWriterCapabilityBrand: unique symbol;
declare const stateLockCapabilityBrand: unique symbol;

export type TerminalLockCapability = Readonly<{
  [terminalLockCapabilityBrand]: true;
}>;

export type StoreWriterCapability = Readonly<{
  [storeWriterCapabilityBrand]: true;
}>;

export type StateLockCapability = Readonly<{
  [stateLockCapabilityBrand]: true;
}>;

export type MutationTransactionCapabilities = Readonly<{
  terminal: TerminalLockCapability;
  storeWriter: StoreWriterCapability;
  state?: StateLockCapability;
}>;

export type MutationTransactionPorts = Readonly<{
  acquireTerminal: () => Awaitable<Release>;
  withStoreWriter: <Result>(
    operation: () => Promise<Result>
  ) => Promise<Result>;
  acquireState?: () => Awaitable<Release>;
}>;

const TERMINAL_LOCK_CAPABILITY = Object.freeze(
  {} as TerminalLockCapability
);
const STORE_WRITER_CAPABILITY = Object.freeze(
  {} as StoreWriterCapability
);
const STATE_LOCK_CAPABILITY = Object.freeze(
  {} as StateLockCapability
);

/**
 * Acquire terminal -> Store writer -> optional state and release in reverse.
 * Errors are deliberately neither wrapped nor translated.
 */
export async function withMutationTransaction<Result>(
  ports: MutationTransactionPorts,
  operation: (
    capabilities: MutationTransactionCapabilities
  ) => Promise<Result>
): Promise<Result> {
  const releaseTerminal = await ports.acquireTerminal();
  try {
    return await ports.withStoreWriter(async () => {
      if (!ports.acquireState) {
        return operation({
          terminal: TERMINAL_LOCK_CAPABILITY,
          storeWriter: STORE_WRITER_CAPABILITY
        });
      }

      const releaseState = await ports.acquireState();
      try {
        return await operation({
          terminal: TERMINAL_LOCK_CAPABILITY,
          storeWriter: STORE_WRITER_CAPABILITY,
          state: STATE_LOCK_CAPABILITY
        });
      } finally {
        releaseState();
      }
    });
  } finally {
    releaseTerminal();
  }
}

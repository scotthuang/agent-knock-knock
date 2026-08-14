/**
 * This shell owns only canonical lock nesting. Business state, durable writes,
 * terminal effects, and their ordering stay in the caller-supplied operation.
 *
 * It deliberately does not expose a "capability" yet: no persistence or
 * terminal port consumes such a token, so presenting one would imply a safety
 * boundary the type system does not currently enforce.
 */

type Awaitable<Value> = Value | PromiseLike<Value>;
type Release = () => void;

export type CanonicalMutationLockPorts = Readonly<{
  acquireTerminal: () => Awaitable<Release>;
  withStoreWriter: <Result>(
    operation: () => Promise<Result>
  ) => Promise<Result>;
  acquireState?: () => Awaitable<Release>;
}>;

/**
 * Acquire terminal -> Store writer -> optional state and release in reverse.
 * Errors are deliberately neither wrapped nor translated.
 */
export async function withCanonicalMutationLocks<Result>(
  ports: CanonicalMutationLockPorts,
  operation: () => Promise<Result>
): Promise<Result> {
  const releaseTerminal = await ports.acquireTerminal();
  try {
    return await ports.withStoreWriter(async () => {
      if (!ports.acquireState) {
        return operation();
      }

      const releaseState = await ports.acquireState();
      try {
        return await operation();
      } finally {
        releaseState();
      }
    });
  } finally {
    releaseTerminal();
  }
}

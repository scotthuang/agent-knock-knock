export const HOST_LIFECYCLE_INTERVAL_MS = 5_000;

export type HostLifecycleSweepReason = "startup" | "periodic";

export interface HostLifecyclePhaseContext {
  reason: HostLifecycleSweepReason;
}

export interface HostLifecyclePhase {
  name: string;
  run(context: HostLifecyclePhaseContext): Promise<void> | void;
}

export interface HostLifecyclePhaseError {
  phase: string;
  reason: HostLifecycleSweepReason;
  error: unknown;
}

/**
 * Schedule one deferred callback and return a function that cancels it.
 *
 * A host may use this seam to choose whether the underlying timer is ref'ed or
 * unref'ed. The default scheduler uses a normal ref'ed Node.js timer.
 */
export type HostLifecycleSchedule = (
  callback: () => void,
  delayMs: number
) => () => void;

export interface HostLifecycleServiceOptions {
  intervalMs?: number;
  phases: readonly HostLifecyclePhase[];
  onPhaseError(error: HostLifecyclePhaseError): void;
  schedule?: HostLifecycleSchedule;
}

export interface HostLifecycleService {
  start(): void;
  stop(): Promise<void>;
}

type HostLifecycleState = "idle" | "running" | "stopping";

const defaultSchedule: HostLifecycleSchedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function normalizedIntervalMs(configuredIntervalMs: number | undefined): number {
  return Number.isFinite(configuredIntervalMs) && Number(configuredIntervalMs) > 0
    ? Math.max(50, Math.ceil(Number(configuredIntervalMs)))
    : HOST_LIFECYCLE_INTERVAL_MS;
}

/**
 * Run host-owned AKK reconciliation for as long as the embedding host is live.
 *
 * The service owns no process, Store, callback transport, or host configuration.
 * Its phases are compile-time injected by the host adapter and run sequentially
 * with independent error boundaries.
 */
export function createHostLifecycleService(
  options: HostLifecycleServiceOptions
): HostLifecycleService {
  const intervalMs = normalizedIntervalMs(options.intervalMs);
  const scheduleAfter = options.schedule ?? defaultSchedule;
  let state: HostLifecycleState = "idle";
  let cancelScheduled: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let stopDrain: Promise<void> | undefined;

  const runSweep = async (reason: HostLifecycleSweepReason): Promise<void> => {
    for (const phase of options.phases) {
      try {
        await phase.run({ reason });
      } catch (error) {
        try {
          options.onPhaseError({
            phase: phase.name,
            reason,
            error
          });
        } catch {
          // A host logger/reporting failure must not suppress later phases.
        }
      }
    }
  };

  const beginSweep = (
    reason: HostLifecycleSweepReason,
    after: () => void
  ): void => {
    let settle!: () => void;
    let reject!: (error: unknown) => void;
    const execution = new Promise<void>((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
    });
    const sweep = execution.finally(() => {
      if (inFlight === sweep) {
        inFlight = undefined;
      }
      after();
    });
    // Register before invoking phase code. A phase may synchronously request
    // Host shutdown; stop() must observe and drain the complete sweep while
    // phase startup retains its pre-extraction synchronous ordering.
    inFlight = sweep;
    void runSweep(reason).then(settle, reject);
  };

  const scheduleNext = (): void => {
    if (state !== "running") {
      return;
    }
    cancelScheduled = scheduleAfter(() => {
      cancelScheduled = undefined;
      beginSweep("periodic", scheduleNext);
    }, intervalMs);
  };

  return {
    start(): void {
      if (state !== "idle") {
        return;
      }
      state = "running";
      beginSweep("startup", scheduleNext);
    },

    async stop(): Promise<void> {
      if (state === "idle") {
        return;
      }
      if (state === "stopping") {
        await stopDrain;
        return;
      }
      state = "stopping";
      cancelScheduled?.();
      cancelScheduled = undefined;
      const activeSweep = inFlight;
      stopDrain = (async () => {
        await activeSweep;
        state = "idle";
        stopDrain = undefined;
      })();
      await stopDrain;
    }
  };
}

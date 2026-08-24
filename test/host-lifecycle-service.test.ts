import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_LIFECYCLE_INTERVAL_MS,
  createHostLifecycleService,
  type HostLifecycleSchedule
} from "../src/host-lifecycle-service.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function controlledSchedule(): {
  schedule: HostLifecycleSchedule;
  delays: number[];
  pendingCount: () => number;
  runNext: () => void;
  cancellations: () => number;
} {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  let cancelled = 0;
  return {
    schedule(callback, delayMs) {
      callbacks.push(callback);
      delays.push(delayMs);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        cancelled += 1;
        const index = callbacks.indexOf(callback);
        if (index >= 0) {
          callbacks.splice(index, 1);
        }
      };
    },
    delays,
    pendingCount: () => callbacks.length,
    runNext() {
      const callback = callbacks.shift();
      assert.ok(callback, "expected a scheduled lifecycle callback");
      callback();
    },
    cancellations: () => cancelled
  };
}

test("host lifecycle isolates phases and schedules periodic work after startup", async () => {
  const timer = controlledSchedule();
  const calls: string[] = [];
  const errors: Array<{ phase: string; reason: string; message: string }> = [];
  const service = createHostLifecycleService({
    intervalMs: 1,
    schedule: timer.schedule,
    phases: [
      {
        name: "managed_turns",
        run({ reason }) {
          calls.push(`managed:${reason}`);
          throw new Error("managed unavailable");
        }
      },
      {
        name: "terminal_watches",
        run({ reason }) {
          calls.push(`watches:${reason}`);
        }
      }
    ],
    onPhaseError({ phase, reason, error }) {
      errors.push({
        phase,
        reason,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  service.start();
  await flushMicrotasks();

  assert.deepEqual(calls, ["managed:startup", "watches:startup"]);
  assert.deepEqual(errors, [{
    phase: "managed_turns",
    reason: "startup",
    message: "managed unavailable"
  }]);
  assert.deepEqual(timer.delays, [50]);
  assert.equal(timer.pendingCount(), 1);

  timer.runNext();
  await flushMicrotasks();

  assert.deepEqual(calls, [
    "managed:startup",
    "watches:startup",
    "managed:periodic",
    "watches:periodic"
  ]);
  assert.equal(timer.pendingCount(), 1);
  await service.stop();
});

test("periodic sweeps never overlap and stop drains in-flight work", async () => {
  const timer = controlledSchedule();
  const periodicPhase = deferred();
  let periodicRuns = 0;
  const service = createHostLifecycleService({
    schedule: timer.schedule,
    phases: [{
      name: "managed_turns",
      async run({ reason }) {
        if (reason === "periodic") {
          periodicRuns += 1;
          await periodicPhase.promise;
        }
      }
    }],
    onPhaseError() {}
  });

  service.start();
  await flushMicrotasks();
  assert.deepEqual(timer.delays, [HOST_LIFECYCLE_INTERVAL_MS]);

  timer.runNext();
  await flushMicrotasks();
  assert.equal(periodicRuns, 1);
  assert.equal(timer.pendingCount(), 0, "next sweep waits for the active sweep");

  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  await flushMicrotasks();
  assert.equal(stopped, false, "stop waits for the active sweep");

  periodicPhase.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(timer.pendingCount(), 0, "stop prevents rescheduling after drain");
});

test("stop cancels a scheduled sweep and start is idempotent", async () => {
  const timer = controlledSchedule();
  let startupRuns = 0;
  const service = createHostLifecycleService({
    schedule: timer.schedule,
    phases: [{
      name: "managed_turns",
      run() {
        startupRuns += 1;
      }
    }],
    onPhaseError() {}
  });

  service.start();
  service.start();
  await flushMicrotasks();

  assert.equal(startupRuns, 1);
  assert.equal(timer.pendingCount(), 1);
  await service.stop();
  assert.equal(timer.pendingCount(), 0);
  assert.equal(timer.cancellations(), 1);
});

test("start cannot create a second schedule chain while stop drains", async () => {
  const timer = controlledSchedule();
  const firstStartup = deferred();
  let startupRuns = 0;
  const service = createHostLifecycleService({
    schedule: timer.schedule,
    phases: [{
      name: "managed_turns",
      async run({ reason }) {
        if (reason !== "startup") {
          return;
        }
        startupRuns += 1;
        if (startupRuns === 1) {
          await firstStartup.promise;
        }
      }
    }],
    onPhaseError() {}
  });

  service.start();
  await flushMicrotasks();
  const stopping = service.stop();
  service.start();
  assert.equal(startupRuns, 1, "start is ignored while stop is draining");

  firstStartup.resolve();
  await stopping;
  assert.equal(timer.pendingCount(), 0);

  service.start();
  await flushMicrotasks();
  assert.equal(startupRuns, 2, "start works again after stop completes");
  assert.equal(timer.pendingCount(), 1);
  await service.stop();
});

test("phase error reporting cannot suppress the following phase", async () => {
  const timer = controlledSchedule();
  let followingPhaseRan = false;
  const service = createHostLifecycleService({
    schedule: timer.schedule,
    phases: [
      {
        name: "managed_turns",
        run() {
          throw new Error("phase failed");
        }
      },
      {
        name: "terminal_watches",
        run() {
          followingPhaseRan = true;
        }
      }
    ],
    onPhaseError() {
      throw new Error("logger failed");
    }
  });

  service.start();
  await flushMicrotasks();
  assert.equal(followingPhaseRan, true);
  await service.stop();
});

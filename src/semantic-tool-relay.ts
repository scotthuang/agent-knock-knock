import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface SemanticToolRelayOptions {
  readonly cwd?: string;
  readonly allowNonzeroJson?: boolean;
  readonly timeoutMs?: number;
}

export const defaultSemanticToolRelayPath = fileURLToPath(
  new URL("./cli.js", import.meta.url)
);

const relayPathByOwner = new WeakMap<object, string>();
const relayEnvironmentByOwner = new WeakMap<object, NodeJS.ProcessEnv>();
const asyncRelayOwners = new WeakSet<object>();
const invocationStorage = new AsyncLocalStorage<{
  readonly signal?: AbortSignal;
}>();

export function bindSemanticToolRelayPath(
  owner: object,
  relayPath: string
): void {
  relayPathByOwner.set(owner, relayPath);
}

/** Bind a private child-process environment for one exact Host owner. */
export function bindSemanticToolRelayEnvironment(
  owner: object,
  environment: NodeJS.ProcessEnv
): void {
  relayEnvironmentByOwner.set(
    owner,
    Object.freeze({ ...environment }) as NodeJS.ProcessEnv
  );
}

/** Keep an embedding Host's event loop responsive while AKK CLI work runs. */
export function bindSemanticToolAsyncRelay(owner: object): void {
  asyncRelayOwners.add(owner);
}

/** Scope one Host invocation's cancellation without sharing mutable state. */
export function withHostBridgeInvocationSignal<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const effectiveSignal = signal ?? invocationStorage.getStore()?.signal;
  if (effectiveSignal?.aborted) {
    return Promise.reject(hostBridgeAbortError());
  }
  return invocationStorage.run(
    { signal: effectiveSignal },
    async () => operation()
  );
}

export function runCli(
  owner: object,
  cliArgs: readonly string[],
  {
    cwd = process.cwd(),
    allowNonzeroJson = false
  }: SemanticToolRelayOptions = {}
): Record<string, unknown> {
  const binPath = relayPathForOwner(owner);
  const spawned = spawnSync(process.execPath, [binPath, ...cliArgs], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd,
    env: relayEnvironmentForOwner(owner)
  });

  if (spawned.error) {
    throw new Error(
      `agent-knock-knock ${cliArgs[0]} failed to start: ${spawned.error.message}`
    );
  }
  if (spawned.status !== 0) {
    if (allowNonzeroJson && spawned.stdout.trim()) {
      return parseJson(spawned.stdout);
    }
    throw new Error(cleanError(
      spawned.stderr ||
        spawned.stdout ||
        `agent-knock-knock ${cliArgs[0]} exited with status ${spawned.status}`
    ));
  }

  return parseJson(spawned.stdout);
}

export function runCliAsync(
  owner: object,
  cliArgs: readonly string[],
  {
    cwd = process.cwd(),
    allowNonzeroJson = false,
    timeoutMs = 90_000
  }: SemanticToolRelayOptions = {}
): Promise<Record<string, unknown>> {
  const binPath = relayPathForOwner(owner);
  const maxBuffer = 10 * 1024 * 1024;
  const signal = invocationStorage.getStore()?.signal;

  if (signal?.aborted) {
    return Promise.reject(hostBridgeAbortError());
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...cliArgs], {
      cwd,
      env: relayEnvironmentForOwner(owner),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    child.once("error", (error) => {
      cleanup();
      if (aborted) {
        reject(hostBridgeAbortError());
        return;
      }
      reject(new Error(
        `agent-knock-knock ${cliArgs[0]} failed to start: ${error.message}`
      ));
    });
    child.once("close", (status) => {
      cleanup();
      if (aborted) {
        reject(hostBridgeAbortError());
        return;
      }
      if (timedOut) {
        reject(new Error(`agent-knock-knock ${cliArgs[0]} timed out`));
        return;
      }
      if (overflow) {
        reject(new Error(
          `agent-knock-knock ${cliArgs[0]} output exceeded 10 MiB`
        ));
        return;
      }
      if (status !== 0) {
        if (allowNonzeroJson && stdout.trim()) {
          try {
            resolve(parseJson(stdout));
          } catch (error) {
            reject(error);
          }
          return;
        }
        reject(new Error(cleanError(
          stderr ||
            stdout ||
            `agent-knock-knock ${cliArgs[0]} exited with status ${status}`
        )));
        return;
      }
      try {
        resolve(parseJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function runHostAwareCli(
  owner: object,
  cliArgs: readonly string[],
  options: SemanticToolRelayOptions = {}
): Promise<Record<string, unknown>> {
  if (asyncRelayOwners.has(owner)) {
    return runCliAsync(owner, cliArgs, options);
  }
  return runCli(owner, cliArgs, options);
}

function hostBridgeAbortError(): Error {
  const error = new Error("agent-knock-knock Host invocation was aborted");
  error.name = "AbortError";
  return error;
}

function relayPathForOwner(owner: object): string {
  return relayPathByOwner.get(owner) ?? defaultSemanticToolRelayPath;
}

function relayEnvironmentForOwner(owner: object): NodeJS.ProcessEnv {
  return relayEnvironmentByOwner.get(owner) ?? process.env;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `agent-knock-knock CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function cleanError(text: string): string {
  return String(text).trim().slice(0, 2000);
}

import fs from "node:fs";
import { createConnection } from "node:net";

const HERDR_MAX_REQUEST_BYTES = 1024 * 1024;
const HERDR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const HERDR_DEFAULT_TIMEOUT_MS = 5_000;

export interface HerdrWireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrSocketIdentity {
  device: string;
  inode: string;
  ctimeNs: string;
  ownerUid?: number;
}

export interface HerdrRequestOptions {
  expectedSocketIdentity?: HerdrSocketIdentity;
}

export type HerdrRequestFunction = (
  socketPath: string,
  request: HerdrWireRequest,
  options?: HerdrRequestOptions
) => Promise<unknown>;

/** A structured Herdr API rejection received after a complete request. */
export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

/**
 * Raw socket failure with an explicit dispatch boundary.
 *
 * `definitelyNotSent` is true only when the Unix socket never connected or
 * the request was rejected locally before any socket write was attempted.
 */
export class HerdrTransportError extends Error {
  constructor(
    message: string,
    readonly definitelyNotSent: boolean,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "HerdrTransportError";
  }
}

/** Send one newline-delimited JSON request over a Herdr Unix-domain socket. */
export function requestHerdrUnixSocket(
  socketPath: string,
  request: HerdrWireRequest,
  options: {
    timeoutMs?: number;
    maxResponseBytes?: number;
    expectedSocketIdentity?: HerdrSocketIdentity;
  } = {}
): Promise<unknown> {
  let encoded: string;
  try {
    encoded = `${JSON.stringify(request)}\n`;
  } catch (error) {
    return Promise.reject(new HerdrTransportError(
      `failed to encode Herdr request: ${describeError(error)}`,
      true,
      { cause: error }
    ));
  }
  if (Buffer.byteLength(encoded) > HERDR_MAX_REQUEST_BYTES) {
    return Promise.reject(new HerdrTransportError(
      `Herdr request exceeds ${HERDR_MAX_REQUEST_BYTES} bytes`,
      true
    ));
  }

  const timeoutMs = positiveInteger(options.timeoutMs) ?? HERDR_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = positiveInteger(options.maxResponseBytes) ??
    HERDR_MAX_RESPONSE_BYTES;

  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    let response = "";
    const socket = createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    const fail = (message: string, definitelyNotSent: boolean, cause?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new HerdrTransportError(message, definitelyNotSent, { cause }));
    };

    socket.once("connect", () => {
      if (settled) return;
      connected = true;
      if (options.expectedSocketIdentity) {
        let liveSocketIdentity: HerdrSocketIdentity;
        try {
          liveSocketIdentity = readHerdrSocketIdentity(socketPath);
        } catch (error) {
          fail(
            `failed to revalidate Herdr socket ${socketPath}: ${describeError(error)}`,
            true,
            error
          );
          return;
        }
        if (!sameHerdrSocketIdentity(
          options.expectedSocketIdentity,
          liveSocketIdentity
        )) {
          fail(`Herdr socket ${socketPath} changed before request dispatch`, true);
          return;
        }
      }
      try {
        socket.write(encoded, (error?: Error | null) => {
          if (error) {
            fail(`failed to write Herdr request: ${error.message}`, false, error);
          }
        });
      } catch (error) {
        fail(`failed to write Herdr request: ${describeError(error)}`, false, error);
      }
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      response += String(chunk);
      if (Buffer.byteLength(response) > maxResponseBytes) {
        fail(`Herdr response exceeds ${maxResponseBytes} bytes`, false);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      const line = response.slice(0, newline).trim();
      if (!line) {
        fail("Herdr returned an empty response", false);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(`Herdr returned invalid JSON: ${describeError(error)}`, false, error);
        return;
      }
      settled = true;
      socket.destroy();
      resolve(parsed);
    });
    socket.once("timeout", () => {
      fail(`timed out waiting for Herdr socket ${socketPath}`, !connected);
    });
    socket.once("error", (error) => {
      fail(`Herdr socket ${socketPath} failed: ${error.message}`, !connected, error);
    });
    socket.once("end", () => {
      if (!settled) fail("Herdr closed the socket without a response", false);
    });
    socket.once("close", () => {
      if (!settled) fail("Herdr closed the socket without a response", !connected);
    });
  });
}

/** Resolve immutable filesystem identity for one owner-local Herdr socket. */
export function readHerdrSocketIdentity(
  socketPath: string
): HerdrSocketIdentity {
  const stats = fs.lstatSync(socketPath, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new Error(`Herdr endpoint must not be a symbolic link: ${socketPath}`);
  }
  if (!stats.isSocket()) {
    throw new Error(`Herdr endpoint is not a Unix socket: ${socketPath}`);
  }
  const ownerUid = Number(stats.uid);
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (currentUid !== undefined && ownerUid !== currentUid) {
    throw new Error(
      `Herdr socket ${socketPath} is owned by uid ${ownerUid}, expected ${currentUid}`
    );
  }
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    ownerUid
  };
}

export function sameHerdrSocketIdentity(
  left: HerdrSocketIdentity,
  right: HerdrSocketIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.ctimeNs === right.ctimeNs &&
    left.ownerUid === right.ownerUid;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

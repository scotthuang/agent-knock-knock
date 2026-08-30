import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import type {
  CallbackRequest,
  CallbackStatus,
  PiRouteTable,
} from "./routes.js";
import {
  CALLBACK_MAX_REQUEST_BYTES as CALLBACK_BODY_LIMIT_BYTES,
  CALLBACK_MAX_RESPONSE_BYTES,
  CALLBACK_SOCKET_ENV,
  CALLBACK_TIMEOUT_MS,
  CALLBACK_TOKEN_ENV,
} from "./constants.js";

export {
  CALLBACK_MAX_RESPONSE_BYTES,
  CALLBACK_SOCKET_ENV,
  CALLBACK_TIMEOUT_MS,
  CALLBACK_TOKEN_ENV,
};
export const CALLBACK_MAX_BODY_BYTES = CALLBACK_BODY_LIMIT_BYTES;
export const CALLBACK_MAX_REQUEST_BYTES = CALLBACK_MAX_BODY_BYTES + 64 * 1024;

export interface CallbackWireRequest extends CallbackRequest {
  readonly token: string;
}

export interface CallbackWireResponse {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly status: CallbackStatus;
  readonly acceptanceId?: string;
  readonly errorCode?: string;
}

export interface CallbackIpcServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Host an authenticated, one-frame-per-connection Pi callback transport. */
export function createCallbackIpcServer(options: {
  readonly socketPath: string;
  readonly token: string;
  readonly routes: Pick<PiRouteTable, "deliver">;
}): CallbackIpcServer {
  let state: "idle" | "starting" | "running" | "stopped" = "idle";
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(CALLBACK_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => undefined);
    void handleConnection(socket, options);
  });

  return {
    start(): Promise<void> {
      if (state === "running") return Promise.resolve();
      if (state !== "idle") {
        return Promise.reject(new Error("Pi callback IPC server cannot be restarted"));
      }
      if (!options.socketPath || !options.token) {
        state = "stopped";
        return Promise.reject(new Error("Pi callback IPC configuration is invalid"));
      }
      state = "starting";
      return new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => {
          state = "stopped";
          reject(error);
        };
        server.once("error", failed);
        server.listen(options.socketPath, () => {
          server.off("error", failed);
          server.on("error", () => undefined);
          try {
            fs.chmodSync(options.socketPath, 0o600);
          } catch (error) {
            state = "stopped";
            server.close(() => reject(error));
            return;
          }
          state = "running";
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (state === "stopped") return;
      state = "stopped";
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await fs.promises.rm(options.socketPath, { force: true }).catch(() => undefined);
    },
  };
}

/** Send one authenticated request from the short-lived Profile helper. */
export function sendCallbackOverIpc(options: {
  readonly socketPath: string;
  readonly request: CallbackWireRequest;
}): Promise<CallbackWireResponse> {
  const frame = `${JSON.stringify(options.request)}\n`;
  if (Buffer.byteLength(frame, "utf8") > CALLBACK_MAX_REQUEST_BYTES) {
    return Promise.reject(new Error("Pi callback IPC request exceeded its limit"));
  }

  return new Promise<CallbackWireResponse>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setTimeout(CALLBACK_TIMEOUT_MS, () => {
      finish(() => reject(new Error("Pi callback IPC timed out")));
    });
    socket.once("error", () => {
      finish(() => reject(new Error("Pi callback IPC unavailable")));
    });
    socket.once("connect", () => socket.write(frame));
    readFrame(socket, CALLBACK_MAX_RESPONSE_BYTES).then((value) => {
      const response = parseWireResponse(value);
      if (!response) {
        finish(() => reject(new Error("Pi callback IPC response was invalid")));
        return;
      }
      finish(() => resolve(response));
    }, () => {
      finish(() => reject(new Error("Pi callback IPC response was incomplete")));
    });
  });
}

async function handleConnection(
  socket: net.Socket,
  options: {
    readonly token: string;
    readonly routes: Pick<PiRouteTable, "deliver">;
  },
): Promise<void> {
  try {
    const frame = await readFrame(socket, CALLBACK_MAX_REQUEST_BYTES);
    const request = parseWireRequest(frame);
    if (!request) {
      socket.destroy();
      return;
    }
    if (!sameSecret(request.token, options.token)) {
      writeFrame(socket, {
        deliveryId: request.deliveryId,
        messageId: request.messageId,
        status: "rejected",
        errorCode: "callback_authentication_failed",
      });
      return;
    }

    const acknowledgement = await options.routes.deliver(request);
    writeFrame(socket, {
      deliveryId: acknowledgement.request.delivery_id,
      messageId: acknowledgement.request.message_id,
      status: acknowledgement.result.status,
      ...(acknowledgement.result.acceptance_id
        ? { acceptanceId: acknowledgement.result.acceptance_id }
        : {}),
      ...(acknowledgement.result.error_code
        ? { errorCode: acknowledgement.result.error_code }
        : {}),
    });
  } catch {
    socket.destroy();
  }
}

function readFrame(socket: net.Socket, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onData = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a);
      const frameChunk = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      bytes += frameChunk.length;
      if (bytes > maxBytes) {
        finish(new Error("Pi callback IPC frame exceeded its limit"));
        return;
      }
      chunks.push(frameChunk);
      if (newline >= 0) {
        finish(undefined, Buffer.concat(chunks, bytes).toString("utf8"));
      }
    };
    const onEnd = (): void => finish(new Error("Pi callback IPC frame ended early"));
    const onClose = (): void => finish(new Error("Pi callback IPC connection closed"));
    const onError = (): void => finish(new Error("Pi callback IPC failed"));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function writeFrame(socket: net.Socket, value: CallbackWireResponse): void {
  if (socket.destroyed) return;
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > CALLBACK_MAX_RESPONSE_BYTES) {
    socket.destroy();
    return;
  }
  socket.end(frame);
}

function parseWireRequest(value: string): CallbackWireRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const keys = [
    "token",
    "controllerId",
    "deliveryId",
    "messageId",
    "idempotencyKey",
    "body",
  ] as const;
  if (Object.keys(parsed).length !== keys.length) return undefined;
  if (keys.some((key) => typeof parsed[key] !== "string")) return undefined;
  return parsed as unknown as CallbackWireRequest;
}

function parseWireResponse(value: string): CallbackWireResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const allowed = new Set([
    "deliveryId",
    "messageId",
    "status",
    "acceptanceId",
    "errorCode",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined;
  if (typeof parsed.deliveryId !== "string" || typeof parsed.messageId !== "string") {
    return undefined;
  }
  if (!["accepted", "retry", "rejected", "unknown"].includes(String(parsed.status))) {
    return undefined;
  }
  if (parsed.acceptanceId !== undefined && typeof parsed.acceptanceId !== "string") {
    return undefined;
  }
  if (parsed.errorCode !== undefined && typeof parsed.errorCode !== "string") {
    return undefined;
  }
  if (parsed.status === "accepted" && !parsed.acceptanceId) return undefined;
  return parsed as unknown as CallbackWireResponse;
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

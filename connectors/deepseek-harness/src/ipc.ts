import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import {
  CALLBACK_MAX_REQUEST_BYTES,
  CALLBACK_MAX_RESPONSE_BYTES,
  CALLBACK_TIMEOUT_MS,
} from "./constants.js";
import type {
  AgentRouteTable,
  CallbackRequest,
  CallbackStatus,
} from "./routes.js";

export interface CallbackWireRequest extends CallbackRequest {
  readonly token: string;
}

export interface CallbackWireResponse {
  readonly status: CallbackStatus;
  readonly acceptanceId?: string;
  readonly errorCode?: string;
}

export interface CallbackIpcServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCallbackIpcServer(options: {
  readonly socketPath: string;
  readonly token: string;
  readonly routes: AgentRouteTable;
}): CallbackIpcServer {
  let state: "idle" | "starting" | "running" | "stopped" = "idle";
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(CALLBACK_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => undefined);
    readFrame(socket, CALLBACK_MAX_REQUEST_BYTES).then((frame) => {
      const request = parseWireRequest(frame);
      if (!request || !sameSecret(request.token, options.token)) {
        return writeFrame(socket, {
          status: "rejected",
          errorCode: "callback_authentication_failed",
        });
      }
      const acknowledgement = options.routes.deliver(request);
      return writeFrame(socket, {
        status: acknowledgement.result.status,
        ...(acknowledgement.result.acceptance_id
          ? { acceptanceId: acknowledgement.result.acceptance_id }
          : {}),
        ...(acknowledgement.result.error_code
          ? { errorCode: acknowledgement.result.error_code }
          : {}),
      });
    }).catch(() => socket.destroy());
  });

  return {
    start(): Promise<void> {
      if (state === "running") return Promise.resolve();
      if (state !== "idle") {
        return Promise.reject(new Error("AKK callback IPC server cannot be restarted"));
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
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Send one authenticated request from the short-lived callback helper. */
export function sendCallbackOverIpc(options: {
  readonly socketPath: string;
  readonly request: CallbackWireRequest;
}): Promise<CallbackWireResponse> {
  return new Promise<CallbackWireResponse>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let settled = false;
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback();
    };
    socket.setTimeout(CALLBACK_TIMEOUT_MS, () => {
      finish(() => reject(new Error("AKK callback IPC timed out")));
    });
    socket.once("error", () => {
      finish(() => reject(new Error("AKK callback IPC unavailable")));
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    });
    readFrame(socket, CALLBACK_MAX_RESPONSE_BYTES).then((frame) => {
      const response = parseWireResponse(frame);
      if (!response) {
        finish(() => reject(new Error("AKK callback IPC response was invalid")));
        return;
      }
      finish(() => resolve(response));
    }, () => {
      finish(() => reject(new Error("AKK callback IPC response was incomplete")));
    });
  });
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
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish(new Error("AKK callback IPC frame exceeded its limit"));
        return;
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const newline = combined.indexOf(0x0a);
      if (newline >= 0) {
        finish(undefined, combined.subarray(0, newline).toString("utf8"));
      }
    };
    const onEnd = (): void => finish(new Error("AKK callback IPC frame ended early"));
    const onClose = (): void => finish(new Error("AKK callback IPC connection closed"));
    const onError = (): void => finish(new Error("AKK callback IPC failed"));
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function writeFrame(socket: net.Socket, value: CallbackWireResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
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
  if (
    Object.keys(parsed).some((key) =>
      key !== "status" && key !== "acceptanceId" && key !== "errorCode"
    )
  ) return undefined;
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

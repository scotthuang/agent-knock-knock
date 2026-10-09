import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { DesktopIpcError, type DesktopIpcTransport } from "./desktop-types.js";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** A private parent prevents another OS user replacing a trusted socket path. */
export function readDesktopSocketIdentity(socketPath: string): string {
  if (!path.isAbsolute(socketPath) || !process.getuid) {
    throw new DesktopIpcError("unsafe_socket", "Desktop IPC requires an owner-local Unix socket");
  }
  const uid = BigInt(process.getuid());
  const parent = fs.lstatSync(path.dirname(socketPath), { bigint: true });
  const socket = fs.lstatSync(socketPath, { bigint: true });
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077n) !== 0n
    || socket.isSymbolicLink() || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077n) !== 0n) {
    throw new DesktopIpcError("unsafe_socket", "Desktop IPC socket and parent must be private to the current user and must not be symlinks");
  }
  return [parent.dev, parent.ino, socket.dev, socket.ino, socket.ctimeNs].join(":");
}

/** Desktop's private IPC uses a uint32 little-endian length followed by UTF-8 JSON. */
export class DesktopFrameDecoder {
  private buffered = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    if (this.buffered.length + chunk.length > MAX_FRAME_BYTES * 2 + 8) {
      throw new DesktopIpcError("invalid_response", "Desktop IPC receive buffer exceeded limit");
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new DesktopIpcError("invalid_response", "Invalid Desktop IPC frame length");
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      try { messages.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload))); }
      catch { throw new DesktopIpcError("invalid_response", "Invalid Desktop IPC JSON frame"); }
    }
    return messages;
  }
}

export function encodeDesktopFrame(message: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (!payload.length || payload.length > MAX_FRAME_BYTES) throw new DesktopIpcError("invalid_argument", "Desktop IPC frame exceeds limit");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0); payload.copy(frame, 4);
  return frame;
}

export async function connectDesktopIpcTransport(options: {
  socketPath: string; timeoutMs: number;
}): Promise<DesktopIpcTransport> {
  const identity = readDesktopSocketIdentity(options.socketPath);
  const assertIdentity = () => {
    if (readDesktopSocketIdentity(options.socketPath) !== identity) {
      throw new DesktopIpcError("unsafe_socket", "Desktop IPC socket identity changed; reconnect required");
    }
  };
  const socket = net.createConnection({ path: options.socketPath });
  const messages = new Set<(message: unknown) => void>();
  const disconnects = new Set<(error: Error) => void>();
  const decoder = new DesktopFrameDecoder();
  let ended: Error | undefined;
  const finish = (error: Error) => {
    if (ended) return;
    ended = error;
    socket.destroy();
    for (const listener of disconnects) listener(error);
    disconnects.clear(); messages.clear();
  };
  socket.on("data", (chunk) => {
    try { for (const message of decoder.push(chunk)) for (const listener of messages) listener(message); }
    catch (error) { finish(error instanceof Error ? error : new Error("Desktop IPC decode failure")); }
  });
  socket.on("error", (error) => finish(error));
  socket.on("close", () => finish(new DesktopIpcError("closed", "Desktop IPC connection closed")));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new DesktopIpcError("timeout", "Desktop IPC connection timeout")); }, options.timeoutMs);
      const connected = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { clearTimeout(timer); socket.off("connect", connected); disconnects.delete(failed); };
      socket.once("connect", connected); disconnects.add(failed);
    });
    assertIdentity();
  } catch (error) { finish(error instanceof Error ? error : new Error("Desktop IPC connection failed")); throw error; }
  return {
    send(message) {
      if (ended || socket.destroyed || !socket.writable) throw new DesktopIpcError("closed", "Desktop IPC socket is unavailable");
      assertIdentity();
      socket.write(encodeDesktopFrame(message));
    },
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onDisconnect(listener) {
      if (ended) queueMicrotask(() => listener(ended!)); else disconnects.add(listener);
      return () => disconnects.delete(listener);
    },
    close() { finish(new DesktopIpcError("closed", "Desktop IPC client closed")); }
  };
}

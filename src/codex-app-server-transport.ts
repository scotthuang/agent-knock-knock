import fs from "node:fs";
import net from "node:net";
import type WebSocket from "ws";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Internal transport; public read and interaction clients each restrict its methods. */
export interface CodexAppServerReadTransport {
  send(message: string): void;
  onMessage(listener: (message: string) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  close(): void;
}

export async function connectCodexUnixWebSocket(options: {
  socketPath: string;
  timeoutMs: number;
}): Promise<CodexAppServerReadTransport> {
  const stat = fs.statSync(options.socketPath);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Codex app-server control socket is not private to the current user");
  }
  const WebSocketClient = (await import("ws")).default;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient("ws://localhost/", {
      createConnection: () => net.createConnection({ path: options.socketPath }),
      handshakeTimeout: options.timeoutMs,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false
    });
    const failed = (error: Error) => { socket.terminate(); reject(error); };
    socket.once("error", failed);
    socket.once("open", () => {
      socket.removeListener("error", failed);
      socket.on("error", () => {});
      resolve({
        send: (message) => socket.send(message),
        close: () => socket.terminate(),
        onMessage: (listener) => {
          const receive = (data: WebSocket.RawData, binary: boolean) => {
            if (binary) { socket.terminate(); return; }
            listener(data.toString());
          };
          socket.on("message", receive);
          return () => socket.removeListener("message", receive);
        },
        onDisconnect: (listener) => {
          const closed = () => listener(new Error("Codex app-server disconnected"));
          socket.on("error", listener);
          socket.on("close", closed);
          return () => { socket.removeListener("error", listener); socket.removeListener("close", closed); };
        }
      });
    });
  });
}

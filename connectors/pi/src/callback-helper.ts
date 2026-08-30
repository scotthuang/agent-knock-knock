import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CALLBACK_MAX_BODY_BYTES,
  CALLBACK_SOCKET_ENV,
  CALLBACK_TOKEN_ENV,
  sendCallbackOverIpc,
} from "./ipc.js";
import type { CallbackAcknowledgement } from "./routes.js";

export interface CallbackHelperArguments {
  readonly controllerId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
}

/** Execute the Host Profile callback helper without putting authority in argv. */
export async function runCallbackHelper(options: {
  readonly arguments: CallbackHelperArguments;
  readonly body: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<CallbackAcknowledgement> {
  if (Buffer.byteLength(options.body, "utf8") > CALLBACK_MAX_BODY_BYTES) {
    throw new Error("Pi callback body exceeded its limit");
  }
  const socketPath = requiredEnvironment(
    options.environment[CALLBACK_SOCKET_ENV],
    CALLBACK_SOCKET_ENV,
  );
  const token = requiredEnvironment(
    options.environment[CALLBACK_TOKEN_ENV],
    CALLBACK_TOKEN_ENV,
  );
  const response = await sendCallbackOverIpc({
    socketPath,
    request: {
      ...options.arguments,
      body: options.body,
      token,
    },
  });
  if (
    response.deliveryId !== options.arguments.deliveryId ||
    response.messageId !== options.arguments.messageId
  ) {
    throw new Error("Pi callback IPC acknowledgement identity did not match");
  }
  return {
    request: {
      delivery_id: response.deliveryId,
      message_id: response.messageId,
    },
    result: {
      status: response.status,
      ...(response.acceptanceId ? { acceptance_id: response.acceptanceId } : {}),
      ...(response.errorCode ? { error_code: response.errorCode } : {}),
    },
  };
}

export function parseCallbackHelperArguments(argv: readonly string[]): CallbackHelperArguments {
  const values = new Map<string, string>();
  const supported = new Set([
    "--controller-id",
    "--delivery-id",
    "--message-id",
    "--idempotency-key",
  ]);
  if (argv.length % 2 !== 0) {
    throw new Error("invalid Pi AKK callback helper arguments");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !supported.has(flag) || !value || values.has(flag)) {
      throw new Error("invalid Pi AKK callback helper arguments");
    }
    values.set(flag, value);
  }
  return {
    controllerId: requiredArgument(values, "--controller-id"),
    deliveryId: requiredArgument(values, "--delivery-id"),
    messageId: requiredArgument(values, "--message-id"),
    idempotencyKey: requiredArgument(values, "--idempotency-key"),
  };
}

async function main(): Promise<void> {
  let parsed: CallbackHelperArguments | undefined;
  try {
    parsed = parseCallbackHelperArguments(process.argv.slice(2));
    const body = await readStandardInput();
    const acknowledgement = await runCallbackHelper({
      arguments: parsed,
      body,
      environment: process.env,
    });
    process.stdout.write(`${JSON.stringify(acknowledgement)}\n`);
  } catch {
    if (parsed) {
      const fallback: CallbackAcknowledgement = {
        request: {
          delivery_id: parsed.deliveryId,
          message_id: parsed.messageId,
        },
        result: {
          status: "retry",
          error_code: "callback_ipc_unavailable",
        },
      };
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
      return;
    }
    process.stderr.write("agent-knock-knock Pi callback helper configuration is invalid\n");
    process.exitCode = 2;
  }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > CALLBACK_MAX_BODY_BYTES) {
      throw new Error("Pi callback body exceeded its limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function requiredArgument(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`missing ${flag}`);
  }
  return value;
}

function requiredEnvironment(value: string | undefined, name: string): string {
  if (!value || value.trim() !== value || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

if (isDirectExecution()) {
  void main();
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment,
} from "@scotthuang/agent-knock-knock/host-adapter";

import {
  CALLBACK_MAX_RESPONSE_BYTES,
  CALLBACK_SOCKET_ENV,
  CALLBACK_TIMEOUT_MS,
  CALLBACK_TOKEN_ENV,
  CONNECTOR_STATE_DIR_ENV,
  CONNECTOR_VERSION,
  CONTROLLER_ID_ENV,
  PI_HOST_ID,
  SUPPORTED_PI_VERSION,
} from "./constants.js";

const HOST_PROFILE_SCHEMA_URL =
  "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/" +
  "schemas/host-profile-v1.schema.json";

export interface ConnectorProfileResources {
  readonly instanceNonce: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly stateDirectory: string;
  readonly token: string;
  readonly profilePath: string;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  environment(controllerId: string): NodeJS.ProcessEnv;
  remove(): void;
}

/** Create one Pi-runtime-private route-bound Host Profile and IPC authority. */
export function createConnectorProfileResources(
  baseEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): ConnectorProfileResources {
  if (process.platform === "win32") {
    throw new Error(
      "agent-knock-knock-pi POC requires a POSIX Unix socket",
    );
  }

  const instanceNonce = randomBytes(12).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const stateDirectory = resolveStateDirectory(baseEnvironment);
  ensurePrivateDirectory(stateDirectory);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-"));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "callback.sock");
  const profilePath = path.join(directory, "host-profile.json");
  const helperPath = fileURLToPath(new URL("./callback-helper.js", import.meta.url));
  const revision = `${CONNECTOR_VERSION}-${instanceNonce}`;

  const profile = Object.freeze({
    $schema: HOST_PROFILE_SCHEMA_URL,
    schema: "agent-knock-knock/host-profile",
    version: 1,
    id: "pi-native",
    revision,
    compatibility: {
      host: PI_HOST_ID,
      range: `=${SUPPORTED_PI_VERSION}`,
    },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: CONTROLLER_ID_ENV,
      scope: "route_bound_v1",
    },
    callback: {
      driver: "command_json_v1",
      executable: process.execPath,
      arguments: [
        helperPath,
        "--controller-id",
        "${controller.session_id}",
        "--delivery-id",
        "${envelope.delivery_id}",
        "--message-id",
        "${envelope.message_id}",
        "--idempotency-key",
        "${envelope.idempotency_key}",
      ],
      stdin: "${envelope.body}",
      environment: {
        allow: [CALLBACK_SOCKET_ENV, CALLBACK_TOKEN_ENV],
      },
      timeoutMs: CALLBACK_TIMEOUT_MS,
      maxOutputBytes: CALLBACK_MAX_RESPONSE_BYTES,
      acknowledgement: {
        disposition: {
          jsonPointer: "/result/status",
          mapping: {
            accepted: "accepted",
            retry: "retryable_failure",
            rejected: "permanent_failure",
            unknown: "uncertain",
          },
        },
        acceptanceId: { jsonPointer: "/result/acceptance_id" },
        acknowledgedDeliveryId: { jsonPointer: "/request/delivery_id" },
        acknowledgedMessageId: { jsonPointer: "/request/message_id" },
      },
    },
  });

  try {
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const environment = (controllerId: string): NodeJS.ProcessEnv => {
    if (!validIdentity(controllerId)) {
      throw new Error("Pi AKK controller id is missing or invalid");
    }
    const base = {
      ...baseEnvironment,
      [CONTROLLER_ID_ENV]: controllerId,
      [CALLBACK_SOCKET_ENV]: socketPath,
      [CALLBACK_TOKEN_ENV]: token,
    };
    const runtime = createTrustedHostProfileRuntime({
      selection: profilePath,
      host: PI_HOST_ID,
      hostVersion: SUPPORTED_PI_VERSION,
      environment: base,
    });
    return hostProfileRelayEnvironment(runtime, base);
  };

  let fingerprint: string;
  try {
    const validationEnvironment = environment(
      `akk-pi:${instanceNonce}:profile-validation`,
    );
    const candidate = validationEnvironment.AKK_HOST_PROFILE_FINGERPRINT;
    if (!candidate) {
      throw new Error("AKK Host Adapter did not produce a Profile fingerprint");
    }
    fingerprint = candidate;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  let removed = false;
  return Object.freeze({
    instanceNonce,
    directory,
    socketPath,
    stateDirectory,
    token,
    profilePath,
    profile,
    fingerprint,
    environment,
    remove(): void {
      if (removed) return;
      removed = true;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  });
}

function resolveStateDirectory(
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const configured = environment[CONNECTOR_STATE_DIR_ENV];
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${CONNECTOR_STATE_DIR_ENV} must be an absolute path`);
    }
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".pi", "agent", "akk");
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Pi AKK state directory must be a real directory");
  }
  fs.chmodSync(directory, 0o700);
}

function validIdentity(value: string): boolean {
  return value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

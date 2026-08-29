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
  CONTROLLER_ID_ENV,
  DSH_HOST_ID,
  type SupportedDeepSeekHarnessVersion,
} from "./constants.js";

const HOST_PROFILE_SCHEMA_URL =
  "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/" +
  "schemas/host-profile-v1.schema.json";

export interface ConnectorProfileResources {
  readonly instanceNonce: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly token: string;
  readonly profilePath: string;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
  environment(controllerId: string): NodeJS.ProcessEnv;
  remove(): void;
}

/**
 * Create one Host-instance-private, route-bound Profile and its IPC authority.
 *
 * The callback executable is Node itself and the helper path is an absolute
 * package artifact, so callback execution never depends on PATH or a shell.
 */
export function createConnectorProfileResources(
  hostVersion: SupportedDeepSeekHarnessVersion,
  baseEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): ConnectorProfileResources {
  if (process.platform === "win32") {
    throw new Error(
      "agent-knock-knock-deepseek-harness: the first release requires a POSIX Unix socket",
    );
  }

  const instanceNonce = randomBytes(12).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-"));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "callback.sock");
  const profilePath = path.join(directory, "host-profile.json");
  const helperPath = fileURLToPath(new URL("./callback-helper.js", import.meta.url));
  const revision = `0.1.0-${instanceNonce}`;

  const profile = Object.freeze({
    $schema: HOST_PROFILE_SCHEMA_URL,
    schema: "agent-knock-knock/host-profile",
    version: 1,
    id: "deepseek-harness-native",
    revision,
    compatibility: {
      host: DSH_HOST_ID,
      range: `=${hostVersion}`,
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
      throw new Error("DeepSeek Harness controller id is missing or invalid");
    }
    const base = {
      ...baseEnvironment,
      [CONTROLLER_ID_ENV]: controllerId,
      [CALLBACK_SOCKET_ENV]: socketPath,
      [CALLBACK_TOKEN_ENV]: token,
    };
    const runtime = createTrustedHostProfileRuntime({
      selection: profilePath,
      host: DSH_HOST_ID,
      hostVersion,
      environment: base,
    });
    return hostProfileRelayEnvironment(runtime, base);
  };
  let fingerprint: string;
  try {
    const validationEnvironment = environment(
      `akk-dsh:${instanceNonce}:profile-validation`,
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

function validIdentity(value: string): boolean {
  return value.length > 0 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

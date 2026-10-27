import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTrustedHostProfileRuntime,
  hostProfileRelayEnvironment,
  createHostProfileCallbackRecoveryCatalog,
  hostProfileCallbackRecoveryFingerprint,
  AKK_HOST_PROFILE_CALLBACK_RECOVERY,
  AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT,
  type TrustedHostProfileRuntimeV1,
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

export interface ConnectorCallbackRecovery {
  readonly ownerScope: string;
  readonly routes: readonly TrustedHostProfileRuntimeV1["callbackRoute"][];
}

export function connectorCallbackRoute(
  resources: ConnectorProfileResources,
  controllerId: string,
): TrustedHostProfileRuntimeV1["callbackRoute"] {
  if (!validIdentity(controllerId)) throw new Error("invalid callback controller identity");
  return Object.freeze({
    schema: "agent-knock-knock/callback-route", version: 1,
    transport: "command_json_v1", profile_id: String(resources.profile.id),
    profile_revision: String(resources.profile.revision),
    controller_session_id: controllerId,
    capabilities: Object.freeze({ wake: true, respond: true }),
  });
}

/** Keep DSH monitors out of another Host's global callback reconciliation. */
export function resolveConnectorPluginConfig(
  configured: Readonly<Record<string, unknown>> = {},
  homeDirectory: string = os.homedir(),
): Readonly<Record<string, unknown>> {
  if (configured.storeDir !== undefined) {
    if (typeof configured.storeDir !== "string" || !configured.storeDir.trim()) {
      throw new Error("DeepSeek Harness AKK pluginConfig.storeDir must be a non-empty path");
    }
    // Preserve deliberate relative paths and all other core options exactly.
    return Object.freeze({ ...configured });
  }
  return Object.freeze({
    ...configured,
    storeDir: path.join(homeDirectory, ".agent-knock-knock", "hosts", "deepseek-harness", "store"),
  });
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
  recovery?: ConnectorCallbackRecovery,
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
  const content = {
    $schema: HOST_PROFILE_SCHEMA_URL,
    schema: "agent-knock-knock/host-profile",
    version: 1,
    id: "deepseek-harness-native",
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
  };
  // Runtime IPC credentials rotate independently of durable callback ownership.
  // A different package callback contract or Host/profile owner changes revision.
  const revision = recovery
    ? `sha256:${createHash("sha256").update(JSON.stringify([recovery.ownerScope, content])).digest("hex")}`
    : `0.1.0-${instanceNonce}`;
  const profile = Object.freeze({ ...content, revision });
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

  let recoveryEnvironment: NodeJS.ProcessEnv = {};
  const environment = (controllerId: string): NodeJS.ProcessEnv => {
    if (!validIdentity(controllerId)) {
      throw new Error("DeepSeek Harness controller id is missing or invalid");
    }
    const base = {
      ...baseEnvironment,
      // Never inherit another connector instance's recovery authority.
      [AKK_HOST_PROFILE_CALLBACK_RECOVERY]: undefined,
      [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: undefined,
      ...recoveryEnvironment,
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
    if (recovery) {
      const catalog = createHostProfileCallbackRecoveryCatalog({
        currentProfileFingerprint: fingerprint,
        ownerScope: recovery.ownerScope,
        routes: recovery.routes,
      });
      const catalogPath = path.join(directory, "callback-recovery.json");
      fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600, flag: "wx" });
      recoveryEnvironment = {
        [AKK_HOST_PROFILE_CALLBACK_RECOVERY]: catalogPath,
        [AKK_HOST_PROFILE_CALLBACK_RECOVERY_FINGERPRINT]: hostProfileCallbackRecoveryFingerprint(catalog),
      };
    }
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

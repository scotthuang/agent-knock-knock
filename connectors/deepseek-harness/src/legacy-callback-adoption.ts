import fs from "node:fs";
import path from "node:path";

import { createTrustedHostProfileRuntime, readHostCallbackRecoveryWatch,
  type TrustedHostProfileRuntimeV1 } from "@scotthuang/agent-knock-knock/host-adapter";
import { canonicalDirectoryPath, type CallbackAuthority } from "./callback-authority.js";
import type { DshRecoveryHost } from "./host-ports.js";
import { CALLBACK_MAX_RESPONSE_BYTES, CALLBACK_SOCKET_ENV, CALLBACK_TIMEOUT_MS,
  CALLBACK_TOKEN_ENV, CONTROLLER_ID_ENV, DSH_HOST_ID, SUPPORTED_DSH_VERSIONS } from "./constants.js";

export interface LegacyCallbackWatchAdoption {
  readonly watchId: string;
  readonly historicalProfilePath: string;
}

/** Explicit historical authority import; neither old helpers nor IPC credentials are used. */
export async function adoptLegacyCallbackWatches(options: {
  readonly adoptions: readonly LegacyCallbackWatchAdoption[];
  readonly storeDirectory: string;
  readonly authority: CallbackAuthority;
  readonly host: DshRecoveryHost;
}): Promise<void> {
  if (canonicalDirectoryPath(options.storeDirectory) !== canonicalDirectoryPath(options.host.storeDirectory)) {
    throw new Error("legacy callback adoption Store differs from the active DSH owner Store");
  }
  for (const adoption of options.adoptions) {
    try {
      if (options.authority.isWatchAdopted(adoption.watchId)) continue;
      const watch = readHostCallbackRecoveryWatch(options.storeDirectory, adoption.watchId);
      const route = watch.callbackRoute;
      const sessionId = legacySessionId(route);
      const before = privateProfile(adoption.historicalProfilePath);
      const raw: unknown = JSON.parse(before.bytes.toString("utf8"));
      const hostVersion = legacyHostVersion(raw);
      const runtime = createTrustedHostProfileRuntime({
        selection: adoption.historicalProfilePath, host: DSH_HOST_ID, hostVersion,
        environment: { [CONTROLLER_ID_ENV]: route.controller_session_id },
      });
      assertLegacyProfile(runtime, options.host.profileDirectory, route);
      const after = privateProfile(adoption.historicalProfilePath);
      if (before.identity !== after.identity || !before.bytes.equals(after.bytes) ||
          canonical(raw) !== canonical(runtime.selected.profile)) {
        throw new Error("historical Profile changed while its authority was inspected");
      }
      const session = await options.host.observeSessionIdentity(sessionId);
      if (session.sessionId !== sessionId) throw new Error("historical callback Session identity changed");
      options.authority.adoptRoute({ controllerId: route.controller_session_id, session,
        callbackRoute: route, authorization: { explicit: true, scope: options.authority.scope,
          watchId: watch.watchId, historicalProfileFingerprint: runtime.selected.fingerprint } });
    } catch (error) {
      throw new Error(`Cannot adopt DSH callback Watch ${adoption.watchId}; verify its explicit historical Profile and original Session: ${
        error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

function legacySessionId(route: TrustedHostProfileRuntimeV1["callbackRoute"]): string {
  const match = /^akk-dsh:([a-f0-9]{24}):([1-9a-z][0-9a-z]*):([A-Za-z0-9_-]+)$/u
    .exec(route.controller_session_id);
  if (!match || route.transport !== "command_json_v1" || route.profile_id !== "deepseek-harness-native" ||
      route.profile_revision !== `0.1.0-${match[1]}` || route.capabilities?.wake !== true ||
      typeof route.capabilities?.respond !== "boolean") {
    throw new Error("Watch does not carry the original DSH callback route format");
  }
  const sessionId = Buffer.from(match[3]!, "base64url").toString("utf8");
  if (!sessionId || sessionId.length > 4096 || sessionId.trim() !== sessionId ||
      /[\u0000-\u001f\u007f]/u.test(sessionId) || Buffer.from(sessionId).toString("base64url") !== match[3]) {
    throw new Error("historical callback Session encoding is not canonical");
  }
  return sessionId;
}

function legacyHostVersion(raw: unknown): string {
  const compatibility = record(raw) && record(raw.compatibility) ? raw.compatibility : undefined;
  const range = compatibility?.range;
  const version = typeof range === "string" && range.startsWith("=") ? range.slice(1) : "";
  if (!SUPPORTED_DSH_VERSIONS.some((supported) => supported === version)) {
    throw new Error("historical Profile must pin one reviewed DSH Host version");
  }
  return version;
}

function assertLegacyProfile(runtime: TrustedHostProfileRuntimeV1, profileDirectory: string,
  route: TrustedHostProfileRuntimeV1["callbackRoute"]): void {
  const profile = runtime.selected.profile;
  const callback = profile.callback;
  if (callback.driver !== "command_json_v1") throw new Error("historical callback driver changed");
  const helper = callback.arguments[0];
  const profileRoot = fs.realpathSync(profileDirectory);
  if (!path.isAbsolute(callback.executable) || path.basename(callback.executable) !== "node" ||
      typeof helper !== "string" || !path.isAbsolute(helper) || path.normalize(helper) !== helper ||
      !helper.startsWith(`${profileRoot}${path.sep}node_modules${path.sep}`) ||
      !helper.endsWith("/node_modules/@scotthuang/agent-knock-knock-deepseek-harness/lib/callback-helper.js")) {
    throw new Error("historical helper must belong to this DSH Profile's installed connector");
  }
  const expected = {
    $schema: "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/schemas/host-profile-v1.schema.json",
    schema: "agent-knock-knock/host-profile", version: 1, id: "deepseek-harness-native",
    revision: route.profile_revision,
    compatibility: { host: DSH_HOST_ID, range: `=${runtime.hostVersion}` },
    controllerContext: { driver: "environment_v1", sessionIdVariable: CONTROLLER_ID_ENV, scope: "route_bound_v1" },
    callback: { driver: "command_json_v1", executable: callback.executable,
      arguments: [helper, "--controller-id", "${controller.session_id}", "--delivery-id", "${envelope.delivery_id}",
        "--message-id", "${envelope.message_id}", "--idempotency-key", "${envelope.idempotency_key}"],
      stdin: "${envelope.body}", environment: { allow: [CALLBACK_SOCKET_ENV, CALLBACK_TOKEN_ENV] },
      timeoutMs: CALLBACK_TIMEOUT_MS, maxOutputBytes: CALLBACK_MAX_RESPONSE_BYTES,
      acknowledgement: {
        disposition: { jsonPointer: "/result/status", mapping: { accepted: "accepted", retry: "retryable_failure",
          rejected: "permanent_failure", unknown: "uncertain" } },
        acceptanceId: { jsonPointer: "/result/acceptance_id" },
        acknowledgedDeliveryId: { jsonPointer: "/request/delivery_id" },
        acknowledgedMessageId: { jsonPointer: "/request/message_id" },
      },
    },
  };
  if (runtime.selected.source !== "file" || canonical(profile) !== canonical(expected)) {
    throw new Error("historical Profile differs from the reviewed DSH callback contract");
  }
}

function privateProfile(filename: string): { bytes: Buffer; identity: string } {
  if (!path.isAbsolute(filename) || path.extname(filename) !== ".json") {
    throw new Error("historical Profile must be an explicit absolute JSON path");
  }
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n ||
        typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid()) ||
        stat.size > 1024n * 1024n) throw new Error("historical Profile must be a private owner-controlled regular file");
    return { bytes: fs.readFileSync(descriptor), identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":") };
  } finally { fs.closeSync(descriptor); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

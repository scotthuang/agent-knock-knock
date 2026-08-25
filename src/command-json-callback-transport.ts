import { spawnSync } from "node:child_process";

import {
  parseHostProfileV1,
  type HostProfileV1
} from "./host-profile.js";
import {
  callbackEnvelopeMatchesRoute,
  parseCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackEnvelopeV1,
  type CallbackTransport,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";

/*
 * Keep the callback driver behind the canonical transport port. Profile
 * parsing owns untrusted-document validation and is deliberately re-applied
 * here so programmatic callers cannot bypass the same fail-closed contract.
 */

export const COMMAND_JSON_CALLBACK_TRANSPORT_KIND = "command_json_v1";
type CallbackDisposition = CallbackAttemptOutcome["disposition"];

export interface CommandJsonSpawnResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export interface CommandJsonSpawnOptions {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  input: string;
  killSignal: "SIGKILL";
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
}

export type CommandJsonSpawnSync = (
  executable: string,
  arguments_: string[],
  options: CommandJsonSpawnOptions
) => CommandJsonSpawnResult;

export interface CreateCommandJsonCallbackTransportOptions {
  profile: HostProfileV1;
  controllerSessionId: string;
  now?: () => Date;
  environment?: () => NodeJS.ProcessEnv;
  spawnSync?: CommandJsonSpawnSync;
}

export interface CommandJsonCallbackTransport extends CallbackTransport {
  readonly kind: typeof COMMAND_JSON_CALLBACK_TRANSPORT_KIND;
  deliver(input: CallbackTransportDeliverInput): CallbackAttemptOutcome;
}

interface JsonPointerDefinition {
  jsonPointer: string;
}

interface NormalizedAcknowledgement {
  disposition: {
    jsonPointer: string;
    mapping: Readonly<Record<string, CallbackDisposition>>;
  };
  acceptanceId: JsonPointerDefinition;
  acknowledgedDeliveryId: JsonPointerDefinition;
  acknowledgedMessageId: JsonPointerDefinition;
}

interface NormalizedCommandJsonCallback {
  executable: string;
  arguments: readonly string[];
  stdin: string;
  environmentVariables: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  acknowledgement: NormalizedAcknowledgement;
}

interface InterpolationValue {
  value: string;
  sensitiveBody?: boolean;
}

class CommandJsonAcknowledgementError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "CommandJsonAcknowledgementError";
    this.errorCode = errorCode;
  }
}

/**
 * Deliver canonical AKK callback envelopes through one administrator-selected
 * command Profile. The Profile and trusted controller identity are captured at
 * construction time and cannot be supplied by a model-facing delivery call.
 */
export function createCommandJsonCallbackTransport(
  options: CreateCommandJsonCallbackTransportOptions
): CommandJsonCallbackTransport {
  const profile = parseHostProfileV1(options.profile, { source: "built_in" });
  const profileId = profile.id;
  const profileRevision = profile.revision;
  const controllerSessionId = requiredNonBlank(
    options.controllerSessionId,
    "controller session id"
  );
  const callback: NormalizedCommandJsonCallback = Object.freeze({
    executable: profile.callback.executable,
    arguments: profile.callback.arguments,
    stdin: profile.callback.stdin,
    environmentVariables: profile.callback.environment.allow,
    timeoutMs: profile.callback.timeoutMs,
    maxOutputBytes: profile.callback.maxOutputBytes,
    acknowledgement: profile.callback.acknowledgement
  });
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? (() => process.env);
  const runSync: CommandJsonSpawnSync = options.spawnSync ??
    ((executable, arguments_, spawnOptions) =>
      spawnSync(executable, arguments_, spawnOptions));

  return Object.freeze({
    kind: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
    deliver(input): CallbackAttemptOutcome {
      let route;
      try {
        route = parseCallbackRoute(input.route);
      } catch {
        return permanentFailure("command_json_callback_route_invalid");
      }
      if (route.transport !== COMMAND_JSON_CALLBACK_TRANSPORT_KIND) {
        return permanentFailure("unsupported_callback_transport");
      }
      if (route.profile_id !== profileId) {
        return permanentFailure("command_json_callback_profile_mismatch");
      }
      if (route.profile_revision !== profileRevision) {
        return permanentFailure("command_json_callback_profile_revision_mismatch");
      }
      if (route.controller_session_id !== controllerSessionId) {
        return permanentFailure("command_json_controller_session_mismatch");
      }
      if (!callbackEnvelopeMatchesRoute(input.envelope, route)) {
        return permanentFailure("callback_envelope_route_mismatch");
      }
      if (
        !Number.isSafeInteger(input.attempt.number) ||
        input.attempt.number < 1 ||
        !nonBlank(input.attempt.id)
      ) {
        return permanentFailure("command_json_callback_attempt_invalid");
      }

      let arguments_: string[];
      let stdin: string;
      let env: NodeJS.ProcessEnv;
      try {
        const values = interpolationValues(input.envelope, controllerSessionId);
        arguments_ = callback.arguments.map((argument) =>
          interpolate(argument, values, "argument")
        );
        stdin = interpolate(callback.stdin, values, "stdin");
        env = filteredEnvironment(
          environment(),
          callback.environmentVariables
        );
      } catch {
        return permanentFailure("command_json_callback_configuration_error");
      }

      let result: CommandJsonSpawnResult;
      try {
        result = runSync(callback.executable, arguments_, {
          encoding: "utf8",
          env,
          input: stdin,
          killSignal: "SIGKILL",
          maxBuffer: callback.maxOutputBytes,
          shell: false,
          timeout: callback.timeoutMs,
          windowsHide: true
        });
      } catch (error) {
        return processExecutionFailure(error, now());
      }

      // A spawn error means the process did not complete inside the bounded
      // execution contract. In particular, stdout emitted before a timeout or
      // output-limit kill cannot prove that the Host finished processing the
      // callback, even when it happens to contain an exact accepted payload.
      if (result.error) {
        return processExecutionFailure(result.error, now());
      }

      const acknowledgement = acknowledgementOutcome({
        callback,
        envelope: input.envelope,
        result,
        now: now()
      });
      if (acknowledgement) {
        if (acknowledgement.disposition === "accepted") {
          try {
            input.reportCheckpoint?.(acknowledgement);
          } catch {
            // The exact command acknowledgement remains authoritative even when
            // the caller cannot persist the optional early checkpoint here.
          }
        }
        return acknowledgement;
      }
      return uncertainFailure(
        result.status === 0
          ? "command_json_callback_acknowledgement_invalid"
          : "command_json_callback_exit_unacknowledged",
        now()
      );
    }
  });
}

function acknowledgementOutcome(input: {
  callback: NormalizedCommandJsonCallback;
  envelope: CallbackEnvelopeV1;
  result: CommandJsonSpawnResult;
  now: Date;
}): CallbackAttemptOutcome | undefined {
  const stdout = typeof input.result.stdout === "string"
    ? input.result.stdout.trim()
    : "";
  if (!stdout) return undefined;

  let acknowledgement: unknown;
  try {
    acknowledgement = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  try {
    const definition = input.callback.acknowledgement;
    const hostDisposition = requiredPointerString(
      acknowledgement,
      definition.disposition,
      "disposition"
    );
    const disposition = Object.hasOwn(
      definition.disposition.mapping,
      hostDisposition
    )
      ? definition.disposition.mapping[hostDisposition]
      : undefined;
    if (!disposition) {
      throw new CommandJsonAcknowledgementError(
        "command_json_callback_acknowledgement_disposition_unknown",
        "callback acknowledgement disposition is not mapped"
      );
    }
    const deliveryId = requiredPointerString(
      acknowledgement,
      definition.acknowledgedDeliveryId,
      "acknowledged delivery id"
    );
    const messageId = requiredPointerString(
      acknowledgement,
      definition.acknowledgedMessageId,
      "acknowledged message id"
    );
    if (
      deliveryId !== input.envelope.delivery_id ||
      messageId !== input.envelope.event.id
    ) {
      throw new CommandJsonAcknowledgementError(
        "command_json_callback_acknowledgement_identity_mismatch",
        "callback acknowledgement does not bind the exact delivery and message"
      );
    }
    if (disposition === "accepted") {
      const acceptanceId = requiredPointerString(
        acknowledgement,
        definition.acceptanceId,
        "acceptance id"
      );
      return {
        disposition,
        accepted_at: input.now.toISOString(),
        acceptance_id: acceptanceId,
        evidence: processEvidence(input.result)
      };
    }
    const errorCode = defaultOutcomeErrorCode(disposition);
    if (disposition === "uncertain") {
      return {
        disposition,
        error_code: errorCode,
        observed_at: input.now.toISOString(),
        evidence: processEvidence(input.result)
      };
    }
    return {
      disposition,
      error_code: errorCode,
      evidence: processEvidence(input.result)
    };
  } catch (error) {
    const errorCode = error instanceof CommandJsonAcknowledgementError
      ? error.errorCode
      : "command_json_callback_acknowledgement_invalid";
    return uncertainFailure(errorCode, input.now);
  }
}

function processEvidence(
  result: CommandJsonSpawnResult
): Record<string, unknown> {
  return {
    transport: COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
    process_status: result.status,
    ...(result.signal ? { process_signal: result.signal } : {})
  };
}

function processExecutionFailure(
  error: unknown,
  observedAt: Date
): CallbackAttemptOutcome {
  const code = errorCode(error);
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) {
    return permanentFailure("command_json_callback_executable_unavailable");
  }
  return uncertainFailure(
    code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        code === "ENOBUFS"
      ? "command_json_callback_execution_limit_uncertain"
      : "command_json_callback_execution_uncertain",
    observedAt
  );
}

function interpolationValues(
  envelope: CallbackEnvelopeV1,
  controllerSessionId: string
): ReadonlyMap<string, InterpolationValue> {
  const values = new Map<string, InterpolationValue>();
  const add = (
    name: string,
    value: string | number | boolean | undefined,
    sensitiveBody = false
  ): void => {
    if (value !== undefined) {
      values.set(name, { value: String(value), sensitiveBody });
    }
  };
  add("controller.session_id", controllerSessionId);
  add("envelope.delivery_id", envelope.delivery_id);
  add("envelope.idempotency_key", envelope.idempotency_key);
  add("envelope.message_id", envelope.event.id);
  add("envelope.body", envelope.event.body, true);
  return values;
}

function interpolate(
  template: string,
  values: ReadonlyMap<string, InterpolationValue>,
  destination: "argument" | "stdin"
): string {
  let malformed = false;
  const rendered = template.replace(/\$\{([^{}]+)\}/gu, (_match, name) => {
    const resolved = values.get(String(name));
    if (!resolved || (destination === "argument" && resolved.sensitiveBody)) {
      malformed = true;
      return "";
    }
    return resolved.value;
  });
  if (malformed || rendered.includes("${")) {
    throw new Error("command_json_v1 interpolation is unsupported or malformed");
  }
  assertNoNullByte(rendered, `command_json_v1 ${destination}`);
  return rendered;
}

function filteredEnvironment(
  source: NodeJS.ProcessEnv,
  allowed: readonly string[]
): NodeJS.ProcessEnv {
  const filtered = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of allowed) {
    if (Object.hasOwn(source, name) && source[name] !== undefined) {
      filtered[name] = source[name];
    }
  }
  return filtered;
}

function requiredPointerString(
  document: unknown,
  definition: JsonPointerDefinition,
  label: string
): string {
  const value = resolveJsonPointer(document, definition.jsonPointer);
  if (!nonBlank(value)) {
    throw new CommandJsonAcknowledgementError(
      "command_json_callback_acknowledgement_invalid",
      `callback acknowledgement ${label} must be a non-empty string`
    );
  }
  return value;
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, token)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function defaultOutcomeErrorCode(
  disposition: Exclude<CallbackDisposition, "accepted">
): string {
  return `command_json_callback_${disposition}`;
}

function permanentFailure(
  errorCode: string
): Extract<CallbackAttemptOutcome, { disposition: "permanent_failure" }> {
  return { disposition: "permanent_failure", error_code: errorCode };
}

function uncertainFailure(
  errorCode: string,
  observedAt: Date
): Extract<CallbackAttemptOutcome, { disposition: "uncertain" }> {
  return {
    disposition: "uncertain",
    error_code: errorCode,
    observed_at: observedAt.toISOString()
  };
}

function requiredNonBlank(value: unknown, label: string): string {
  if (!nonBlank(value)) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNoNullByte(value: string, label: string): void {
  if (value.includes("\0")) throw new Error(`${label} contains a null byte`);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as NodeJS.ErrnoException).code;
  return typeof value === "string" ? value : undefined;
}

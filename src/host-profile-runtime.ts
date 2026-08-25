import {
  assertHostProfileCompatibility,
  createHostProfileRegistry,
  hostProfileControllerScope,
  hostProfileFingerprint,
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES,
  loadHostProfileV1,
  resolveHostProfileControllerContext,
  type HostProfileControllerScopeV1,
  type HostProfileRegistry,
  type HostProfileV1
} from "./host-profile.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  type CallbackRouteV1
} from "./callback-transport.js";

export const AKK_HOST_PROFILE_SELECTION =
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES[0];
export const AKK_HOST_PROFILE_SOURCE =
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES[1];
export const AKK_HOST_PROFILE_FINGERPRINT =
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES[2];
export const AKK_HOST_PROFILE_HOST =
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES[3];
export const AKK_HOST_PROFILE_HOST_VERSION =
  HOST_PROFILE_PRIVATE_ENVIRONMENT_VARIABLES[4];

export const defaultHostProfileRegistry = createHostProfileRegistry();

export interface SelectedHostProfileV1 {
  readonly source: "built_in" | "file";
  readonly selection: string;
  readonly fingerprint: string;
  readonly profile: HostProfileV1;
}

export interface TrustedHostProfileRuntimeV1 {
  readonly selected: SelectedHostProfileV1;
  readonly controllerScope: HostProfileControllerScopeV1;
  readonly controllerSessionId: string;
  readonly host: string;
  readonly hostVersion: string;
  readonly callbackRoute: CallbackRouteV1;
}

export interface SelectHostProfileOptions {
  readonly cwd?: string;
  readonly registry?: HostProfileRegistry;
}

export interface CreateTrustedHostProfileRuntimeOptions
  extends SelectHostProfileOptions {
  readonly selection: string;
  readonly host: string;
  readonly hostVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve one startup-selected Profile. A registry id wins over filesystem
 * interpretation so an explicit user file cannot shadow a bundled Profile.
 */
export function selectHostProfileV1(
  selection: string,
  options: SelectHostProfileOptions = {}
): SelectedHostProfileV1 {
  const requested = requiredCleanString(selection, "host profile selection");
  const registry = options.registry ?? defaultHostProfileRegistry;
  const builtIn = registry.resolve(requested);
  if (builtIn) {
    return Object.freeze({
      source: "built_in" as const,
      selection: builtIn.id,
      fingerprint: hostProfileFingerprint(builtIn),
      profile: builtIn
    });
  }
  const loaded = loadHostProfileV1(requested, {
    cwd: options.cwd,
    registry
  });
  return Object.freeze({
    source: "file" as const,
    selection: loaded.path,
    fingerprint: loaded.fingerprint,
    profile: loaded.profile
  });
}

/** Capture all authority needed by a Host-launched Bridge at startup. */
export function createTrustedHostProfileRuntime(
  options: CreateTrustedHostProfileRuntimeOptions
): TrustedHostProfileRuntimeV1 {
  const selected = selectHostProfileV1(options.selection, options);
  const host = requiredCleanString(options.host, "controller Host id");
  const hostVersion = requiredCleanString(
    options.hostVersion,
    "controller Host version"
  );
  assertHostProfileCompatibility(selected.profile, {
    host,
    version: hostVersion
  });
  const context = resolveHostProfileControllerContext(
    selected.profile,
    options.environment
  );
  return Object.freeze({
    selected,
    controllerScope: hostProfileControllerScope(selected.profile),
    controllerSessionId: context.controllerSessionId,
    host,
    hostVersion,
    callbackRoute: callbackRouteForHostProfile(
      selected.profile,
      context.controllerSessionId
    )
  });
}

/**
 * Build the private child-process environment used by the Bridge. The exact
 * Profile fingerprint and route-creation controller identity are captured
 * once; model-facing tool arguments have no route/profile fields and cannot
 * override them. A route-bound callback later uses only that persisted route.
 */
export function hostProfileRelayEnvironment(
  runtime: TrustedHostProfileRuntimeV1,
  baseEnvironment: Readonly<NodeJS.ProcessEnv>
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    [AKK_HOST_PROFILE_SELECTION]: runtime.selected.selection,
    [AKK_HOST_PROFILE_SOURCE]: runtime.selected.source,
    [AKK_HOST_PROFILE_FINGERPRINT]: runtime.selected.fingerprint,
    [AKK_HOST_PROFILE_HOST]: runtime.host,
    [AKK_HOST_PROFILE_HOST_VERSION]: runtime.hostVersion,
    [runtime.selected.profile.controllerContext.sessionIdVariable]:
      runtime.controllerSessionId
  };
}

/**
 * Re-resolve trusted Bridge authority inside a CLI/monitor child. User Profile
 * edits after Bridge startup fail closed unless their complete fingerprint is
 * unchanged.
 */
export function trustedHostProfileRuntimeFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  options: SelectHostProfileOptions = {}
): TrustedHostProfileRuntimeV1 | undefined {
  const selection = environment[AKK_HOST_PROFILE_SELECTION];
  const markerValues = [
    environment[AKK_HOST_PROFILE_SOURCE],
    environment[AKK_HOST_PROFILE_FINGERPRINT],
    environment[AKK_HOST_PROFILE_HOST],
    environment[AKK_HOST_PROFILE_HOST_VERSION]
  ];
  if (selection === undefined && markerValues.every((value) => value === undefined)) {
    return undefined;
  }
  if (selection === undefined || markerValues.some((value) => value === undefined)) {
    throw new Error("trusted Host Profile runtime environment is incomplete");
  }
  const runtime = createTrustedHostProfileRuntime({
    selection,
    host: environment[AKK_HOST_PROFILE_HOST]!,
    hostVersion: environment[AKK_HOST_PROFILE_HOST_VERSION]!,
    environment,
    ...options
  });
  if (runtime.selected.source !== environment[AKK_HOST_PROFILE_SOURCE]) {
    throw new Error("trusted Host Profile source changed after Bridge startup");
  }
  if (
    runtime.selected.fingerprint !== environment[AKK_HOST_PROFILE_FINGERPRINT]
  ) {
    throw new Error(
      "trusted Host Profile changed after Bridge startup; restart the Host Bridge"
    );
  }
  return runtime;
}

/** Add only trusted in-process route fields needed by new Turn/Watch creation. */
export function applyTrustedHostProfileCliOptions(
  commandName: string | undefined,
  options: Readonly<Record<string, unknown>>,
  environment: Readonly<NodeJS.ProcessEnv>,
  cwd: string
): Record<string, unknown> {
  const runtime = trustedHostProfileRuntimeFromEnvironment(environment, { cwd });
  if (!runtime) return options as Record<string, unknown>;
  const createsManagedTurn = commandName === "delegate" ||
    (commandName === "send" && !nonBlankString(options.turn));
  const ownsTerminalWatchRoute = commandName === "watch-terminal" ||
    commandName === "reconcile-watches";
  if (!createsManagedTurn && !ownsTerminalWatchRoute) {
    return options as Record<string, unknown>;
  }
  return {
    ...options,
    callbackRoute: runtime.callbackRoute,
    callbackRouteControllerScope: runtime.controllerScope,
    openclawSession: runtime.controllerSessionId,
    gatewaySession: runtime.controllerSessionId,
    openclawBin: "agent-knock-knock-host-bridge"
  };
}

export function callbackRouteForHostProfile(
  profile: HostProfileV1,
  controllerSessionId: string
): CallbackRouteV1 {
  return Object.freeze({
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: profile.callback.driver,
    profile_id: profile.id,
    profile_revision: profile.revision,
    controller_session_id: requiredCleanString(
      controllerSessionId,
      "controller session id"
    ),
    capabilities: Object.freeze({ wake: true, respond: true })
  });
}

function requiredCleanString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

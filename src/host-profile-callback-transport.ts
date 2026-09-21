import {
  COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
  createCommandJsonCallbackTransport
} from "./command-json-callback-transport.js";
import type {
  CallbackAttemptOutcome,
  CallbackRouteV1,
  CallbackTransport,
  CallbackTransportDeliverInput
} from "./callback-transport.js";
import {
  trustedHostProfileRuntimeFromEnvironment,
  type SelectHostProfileOptions,
  type TrustedHostProfileRuntimeV1
} from "./host-profile-runtime.js";

export const HOST_PROFILE_CALLBACK_ROUTER_KIND =
  "host_profile_callback_router_v1";

export interface CreateHostProfileCallbackTransportOptions
  extends SelectHostProfileOptions {
  readonly legacyTransport: CallbackTransport;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

/**
 * Route legacy OpenClaw callbacks exactly as before and resolve declarative
 * callbacks only through the private Bridge runtime environment. The Store
 * persists route identity, never executable or credential configuration.
 */
export function createHostProfileCallbackTransport(
  options: CreateHostProfileCallbackTransportOptions
): CallbackTransport {
  return Object.freeze({
    kind: HOST_PROFILE_CALLBACK_ROUTER_KIND,
    deliver(input: CallbackTransportDeliverInput): CallbackAttemptOutcome {
      if (input.route.transport === options.legacyTransport.kind) {
        return options.legacyTransport.deliver(input);
      }
      if (input.route.transport !== COMMAND_JSON_CALLBACK_TRANSPORT_KIND) {
        return permanentFailure("unsupported_callback_transport");
      }

      let runtime;
      try {
        runtime = trustedHostProfileRuntimeFromEnvironment(
          options.environment(),
          { cwd: options.cwd, registry: options.registry }
        );
      } catch {
        return permanentFailure("host_profile_runtime_invalid");
      }
      if (!runtime) {
        return permanentFailure("host_profile_runtime_missing");
      }
      if (!hostProfileCallbackRouteMatchesRuntime(input.route, runtime)) {
        return permanentFailure("host_profile_callback_route_mismatch");
      }

      let transport;
      try {
        transport = createCommandJsonCallbackTransport({
          profile: runtime.selected.profile,
          controllerSessionId:
            runtime.controllerScope === "route_bound_v1"
              ? input.route.controller_session_id
              : runtime.controllerSessionId,
          environment: options.environment,
          now: options.now
        });
      } catch {
        return permanentFailure("host_profile_callback_transport_invalid");
      }
      try {
        return transport.deliver(input);
      } catch {
        return {
          disposition: "uncertain",
          error_code: "host_profile_callback_transport_threw",
          observed_at: (options.now?.() ?? new Date()).toISOString()
        };
      }
    }
  });
}

/** Compare persisted route identity without exporting executable configuration. */
export function hostProfileCallbackRouteMatchesRuntime(
  route: CallbackRouteV1,
  runtime: Pick<TrustedHostProfileRuntimeV1, "callbackRoute" | "controllerScope">
): boolean {
  return runtime.callbackRoute.transport === route.transport &&
    runtime.callbackRoute.profile_id === route.profile_id &&
    runtime.callbackRoute.profile_revision === route.profile_revision &&
    (runtime.controllerScope === "route_bound_v1" ||
      runtime.callbackRoute.controller_session_id === route.controller_session_id);
}

function permanentFailure(errorCode: string): CallbackAttemptOutcome {
  return {
    disposition: "permanent_failure",
    error_code: errorCode
  };
}

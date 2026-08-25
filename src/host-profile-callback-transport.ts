import {
  COMMAND_JSON_CALLBACK_TRANSPORT_KIND,
  createCommandJsonCallbackTransport
} from "./command-json-callback-transport.js";
import type {
  CallbackAttemptOutcome,
  CallbackTransport,
  CallbackTransportDeliverInput
} from "./callback-transport.js";
import {
  trustedHostProfileRuntimeFromEnvironment,
  type SelectHostProfileOptions
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
      if (
        runtime.callbackRoute.transport !== input.route.transport ||
        runtime.callbackRoute.profile_id !== input.route.profile_id ||
        runtime.callbackRoute.profile_revision !== input.route.profile_revision ||
        (
          runtime.controllerScope === "startup_v1" &&
          runtime.callbackRoute.controller_session_id !==
            input.route.controller_session_id
        )
      ) {
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

function permanentFailure(errorCode: string): CallbackAttemptOutcome {
  return {
    disposition: "permanent_failure",
    error_code: errorCode
  };
}

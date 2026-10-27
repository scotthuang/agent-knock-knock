import type { CallbackRouteV1 } from "./callback-transport.js";
import { loadTerminalWatch } from "./terminal-watch-store.js";

export interface HostCallbackRecoveryWatch {
  readonly watchId: string;
  readonly callbackRoute: CallbackRouteV1;
  readonly createdAt: string;
}

/** Read an explicitly selected historical route through the normal Store fences. */
export function readHostCallbackRecoveryWatch(
  storeDir: string,
  watchId: string
): HostCallbackRecoveryWatch {
  const watch = loadTerminalWatch(storeDir, watchId);
  if (!watch.callback_route) {
    throw new Error("the selected Watch has no persisted Host callback route");
  }
  return Object.freeze({
    watchId: watch.watch_id,
    callbackRoute: structuredClone(watch.callback_route),
    createdAt: watch.created_at
  });
}

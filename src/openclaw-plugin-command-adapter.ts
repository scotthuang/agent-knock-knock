import {
  registerSemanticToolCatalog
} from "./semantic-tool-catalog.js";
import {
  createAkkSemanticToolCatalog,
  type DisplayedResumeSnapshotMap
} from "./semantic-tool-runtime.js";

export {
  bindSemanticToolAsyncRelay as bindHostBridgeAsyncRelay,
  bindHostBridgeToolPresentation,
  bindSemanticToolRelayEnvironment as bindOpenClawRelayEnvironment,
  bindSemanticToolRelayPath as bindOpenClawRelayPath,
  defaultSemanticToolRelayPath as defaultOpenClawRelayPath,
  pushOptional,
  runCli,
  runCliAsync,
  withHostBridgeInvocationSignal
} from "./semantic-tool-runtime.js";

/** Adapt the host-neutral AKK catalog to OpenClaw's registration API. */
export function registerOpenClawCommands(
  api: any,
  displayedResumeSnapshots: DisplayedResumeSnapshotMap
): void {
  registerSemanticToolCatalog(
    api,
    createAkkSemanticToolCatalog(api, displayedResumeSnapshots)
  );
}

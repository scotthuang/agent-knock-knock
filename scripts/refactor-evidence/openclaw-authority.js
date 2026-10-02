import {
  fail,
  assertExactArray,
  readRepositoryFile,
  validateAuthorityPaths,
  assertSourcePattern,
  assertDirectNamedImport
} from "./common.js";

const OPENCLAW_AUTHORITY_ROLES = Object.freeze({
  manifest: "openclaw.plugin.json",
  callback_adapter: "src/openclaw-plugin-callback-adapter.ts",
  command_adapter: "src/openclaw-plugin-command-adapter.ts",
  command_helpers_adapter: "src/openclaw-plugin-helpers.ts",
  tool_schemas_adapter: "src/openclaw-plugin-schemas.ts",
  monitor_supervisor_adapter: "src/openclaw-plugin-supervisor.ts",
  private_authority_adapter: "src/openclaw-private-authority-offers.ts",
  plugin_entry: "src/openclaw-plugin.ts",
  host_monitor_reconciliation: "src/host-monitor-reconciliation.ts",
  semantic_arguments: "src/semantic-tool-arguments.ts",
  semantic_catalog: "src/semantic-tool-catalog.ts",
  semantic_command_helpers: "src/semantic-tool-command-helpers.ts",
  semantic_list_projection: "src/semantic-tool-list-projection.ts",
  semantic_model_facing_policy:
    "src/semantic-tool-model-facing-field-policy.ts",
  semantic_presentation: "src/semantic-tool-presentation.ts",
  semantic_private_authority: "src/semantic-tool-private-authority.ts",
  semantic_permission_control: "src/semantic-permission-control.ts",
  semantic_private_authority_offers:
    "src/semantic-private-authority-offers.ts",
  semantic_relay: "src/semantic-tool-relay.ts",
  semantic_runtime: "src/semantic-tool-runtime.ts",
  semantic_schemas: "src/semantic-tool-schemas.ts",
  semantic_value_helpers: "src/semantic-tool-value-helpers.ts"
});

const OPENCLAW_AUTHORITY_PATHS = Object.freeze(
  Object.values(OPENCLAW_AUTHORITY_ROLES).sort()
);

export function validateOpenClawAuthorityRoles(authorityPaths, repoRoot) {
  assertExactArray(
    authorityPaths,
    OPENCLAW_AUTHORITY_PATHS,
    "OpenClaw authority role paths"
  );
  validateAuthorityPaths(
    authorityPaths,
    "OpenClaw authority_paths",
    repoRoot
  );

  const roles = OPENCLAW_AUTHORITY_ROLES;
  validateSemanticSchemasAndCommands(repoRoot, roles);
  validateSemanticRuntimeImports(repoRoot, roles);
  validatePermissionControlAuthority(repoRoot, roles);
  validateSemanticPrivateAuthority(repoRoot, roles);
  validateOpenClawCallbackAndMonitor(repoRoot, roles);
  validateHostNeutralImports(repoRoot, roles);
  validateOpenClawEntry(repoRoot, roles);
}

function validateSemanticSchemasAndCommands(repoRoot, roles) {
  const schemas = readRepositoryFile(repoRoot, roles.semantic_schemas);
  assertExactArray(
    [...schemas.matchAll(/^export const ([A-Za-z]+Parameters) =/gmu)]
      .map((match) => match[1]),
    [
      "respondInteractionParameters",
      "sendParameters",
      "respondParameters",
      "listParameters",
      "watchParameters",
      "unwatchParameters",
      "listResumableThreadsParameters",
      "nativeInspectParameters",
      "modelOptionsParameters",
      "permissionOptionsParameters",
      "setPermissionsParameters",
      "repairModelControlParameters",
      "setModelParameters",
      "identifyForegroundParameters",
      "identifyAndSendParameters",
      "newThreadParameters",
      "reconcileBindingParameters",
      "resumeThreadParameters",
      "renewParameters",
      "retryCallbackParameters",
      "statusParameters",
      "cancelParameters",
      "closeParameters",
      "approveParameters"
    ],
    "semantic tool-schema role exports"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_schemas,
    "./executors.js",
    ["EXECUTOR_KINDS"],
    "semantic tool-schema role"
  );
  assertSourcePattern(
    repoRoot,
    roles.tool_schemas_adapter,
    /export \* from "\.\/semantic-tool-schemas\.js";/u,
    "OpenClaw tool-schema adapter role"
  );

  assertSourcePattern(
    repoRoot,
    roles.semantic_command_helpers,
    new RegExp([
      String.raw`export const AKK_CALLBACK_METHOD`,
      String.raw`export function parseAkkCommand\s*\(`,
      String.raw`export function buildAkkCommandCliArgs\s*\(`,
      String.raw`export function resolvePluginStoreDir\s*\(`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "semantic command-helper role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_command_helpers,
    "./value-guards.js",
    ["recordValue"],
    "semantic command-helper role"
  );
  assertSourcePattern(
    repoRoot,
    roles.command_helpers_adapter,
    /export \* from "\.\/semantic-tool-command-helpers\.js";/u,
    "OpenClaw command-helper adapter role"
  );
}

function validateSemanticRuntimeImports(repoRoot, roles) {
  assertSourcePattern(
    repoRoot,
    roles.command_adapter,
    /registerSemanticToolCatalog[\s\S]*?export function registerOpenClawCommands\s*\([\s\S]*?createAkkSemanticToolCatalog/u,
    "OpenClaw command-adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.command_adapter,
    "./semantic-tool-catalog.js",
    ["registerSemanticToolCatalog"],
    "OpenClaw command-adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.command_adapter,
    "./semantic-tool-runtime.js",
    ["createAkkSemanticToolCatalog"],
    "OpenClaw command-adapter role"
  );

  assertSourcePattern(
    repoRoot,
    roles.semantic_runtime,
    /export function createAkkSemanticToolCatalog\s*\([\s\S]*?function registerCliTool\s*\([\s\S]*?runHostAwareCli/u,
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-relay.js",
    ["runHostAwareCli", "withHostBridgeInvocationSignal"],
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-arguments.js",
    ["pushOptional", "requiredString"],
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-private-authority.js",
    ["privateActionArguments", "rememberDisplayedPrivateAuthorityOffers"],
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-presentation.js",
    ["toolResult", "usesHostBridgeToolPresentation"],
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-permission-control.js",
    ["registerPermissionControlTools", "handleAkkPermissionCommand"],
    "semantic permission-control registration boundary"
  );
  assertSourcePattern(
    repoRoot,
    roles.semantic_runtime,
    /registerPermissionControlTools\(api, registerCliTool\)/u,
    "semantic permission-control shared registrar"
  );
}

function validatePermissionControlAuthority(repoRoot, roles) {
  assertSourcePattern(
    repoRoot,
    roles.semantic_permission_control,
    new RegExp([
      String.raw`export async function buildPrivatePermissionOptionsArgs`,
      String.raw`export function rememberDisplayedPermissionOptionsOffer`,
      String.raw`export function buildPrivateSetPermissionsArgs`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "semantic permission-control private authority role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_permission_control,
    "./semantic-private-authority-offers.js",
    ["consumeSemanticPrivateAuthorityOffer", "rememberSemanticPrivateAuthorityOffer"],
    "semantic permission-control single-use offer boundary"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_permission_control,
    "./semantic-tool-arguments.js",
    ["requiredControllerSessionKey", "requiredControllerSessionId"],
    "semantic permission-control controller incarnation boundary"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_permission_control,
    "./semantic-tool-private-authority.js",
    ["assertOnlyModelControlParameters", "privateTerminalActionArguments"],
    "semantic permission-control current terminal authority boundary"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_permission_control,
    "./semantic-tool-schemas.js",
    ["permissionOptionsParameters", "setPermissionsParameters"],
    "semantic permission-control schema boundary"
  );
  assertSourcePattern(
    repoRoot,
    roles.semantic_permission_control,
    new RegExp([
      String.raw`export function registerPermissionControlTools`,
      String.raw`name: "agent_knock_knock_permission_options"`,
      String.raw`parameters: permissionOptionsParameters`,
      String.raw`name: "agent_knock_knock_set_permissions"`,
      String.raw`parameters: setPermissionsParameters`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "semantic permission-control tool registrations"
  );
}

function validateSemanticPrivateAuthority(repoRoot, roles) {
  assertSourcePattern(
    repoRoot,
    roles.semantic_presentation,
    /export function bindHostBridgeToolPresentation[\s\S]*?export function toolResult[\s\S]*?export function modelFacingToolError/u,
    "semantic tool-presentation role"
  );
  assertSourcePattern(
    repoRoot,
    roles.semantic_private_authority,
    new RegExp([
      String.raw`export function rememberDisplayedModelOptionsOffer`,
      String.raw`export async function consumeDisplayedPrivateAction`,
      String.raw`export function buildPrivateInteractionResponseArgs`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "semantic tool-private-authority role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_private_authority,
    "./semantic-tool-relay.js",
    ["runHostAwareCli"],
    "semantic tool-private-authority role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_private_authority,
    "./semantic-private-authority-offers.js",
    [
      "consumeSemanticPrivateAuthorityOffer",
      "rememberSemanticPrivateAuthorityOffer"
    ],
    "semantic tool-private-authority offer-store boundary"
  );
  assertSourcePattern(
    repoRoot,
    roles.private_authority_adapter,
    /from "\.\/semantic-private-authority-offers\.js";/u,
    "OpenClaw private-authority adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_private_authority,
    "./semantic-tool-arguments.js",
    ["pushOptional", "requiredString"],
    "semantic tool-private-authority role"
  );
  assertSourcePattern(
    repoRoot,
    roles.semantic_arguments,
    /export function pushTurnTarget[\s\S]*?export function pushOptional[\s\S]*?export function requiredTerminalInteractionIdentifier/u,
    "semantic tool-arguments role"
  );
  assertSourcePattern(
    repoRoot,
    roles.semantic_relay,
    new RegExp([
      String.raw`const relayPathByOwner = new WeakMap`,
      String.raw`export function bindSemanticToolRelayPath\s*\(`,
      String.raw`export function runCli\s*\(`,
      String.raw`export function runCliAsync\s*\(`,
      String.raw`export async function runHostAwareCli\s*\(`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "semantic tool-relay role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-schemas.js",
    [
      "approveParameters",
      "cancelParameters",
      "closeParameters",
      "identifyAndSendParameters",
      "identifyForegroundParameters",
      "listParameters",
      "listResumableThreadsParameters",
      "modelOptionsParameters",
      "nativeInspectParameters",
      "newThreadParameters",
      "reconcileBindingParameters",
      "repairModelControlParameters",
      "renewParameters",
      "respondParameters",
      "respondInteractionParameters",
      "resumeThreadParameters",
      "retryCallbackParameters",
      "sendParameters",
      "setModelParameters",
      "statusParameters",
      "unwatchParameters",
      "watchParameters"
    ],
    "semantic tool-runtime role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.semantic_runtime,
    "./semantic-tool-command-helpers.js",
    ["AKK_CALLBACK_METHOD", "parseAkkCommand", "resolvePluginStoreDir"],
    "semantic tool-runtime role"
  );
}

function validateOpenClawCallbackAndMonitor(repoRoot, roles) {
  assertSourcePattern(
    repoRoot,
    roles.callback_adapter,
    new RegExp([
      String.raw`export function registerOpenClawCallbackGateway\s*\(`,
      String.raw`async function handleCallback\s*\(`,
      String.raw`function buildCallbackDeliveryPlan\s*\(`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "OpenClaw callback-adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.callback_adapter,
    "./approval-policy.js",
    ["attemptAutoApproval"],
    "OpenClaw callback-adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.callback_adapter,
    "./openclaw-plugin-command-adapter.js",
    ["runCliAsync"],
    "OpenClaw callback-adapter role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.callback_adapter,
    "./openclaw-plugin-helpers.js",
    ["AKK_CALLBACK_METHOD"],
    "OpenClaw callback-adapter role"
  );

  assertSourcePattern(
    repoRoot,
    roles.host_monitor_reconciliation,
    new RegExp([
      String.raw`export const HOST_MONITOR_RECONCILIATION_INTERVAL_MS`,
      String.raw`export function createHostMonitorReconciliationService\s*\(`,
      String.raw`agent-knock-knock-monitor-reconciliation`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "Host monitor-reconciliation role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.host_monitor_reconciliation,
    "./host-lifecycle-service.js",
    ["createHostLifecycleService", "HOST_LIFECYCLE_INTERVAL_MS"],
    "Host monitor-reconciliation role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.host_monitor_reconciliation,
    "./semantic-tool-relay.js",
    ["runCliAsync"],
    "Host monitor-reconciliation role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.host_monitor_reconciliation,
    "./semantic-tool-command-helpers.js",
    ["resolvePluginStoreDir"],
    "Host monitor-reconciliation role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.monitor_supervisor_adapter,
    "./host-monitor-reconciliation.js",
    [
      "createHostMonitorReconciliationService",
      "HOST_MONITOR_RECONCILIATION_INTERVAL_MS"
    ],
    "OpenClaw monitor-supervisor adapter role"
  );
}

function validateHostNeutralImports(repoRoot, roles) {
  for (const repositoryPath of [
    "src/host-adapter.ts",
    "src/host-bridge-tools.ts",
    "src/host-bridge.ts",
    roles.host_monitor_reconciliation,
    roles.semantic_arguments,
    roles.semantic_catalog,
    roles.semantic_command_helpers,
    roles.semantic_list_projection,
    roles.semantic_model_facing_policy,
    roles.semantic_presentation,
    roles.semantic_private_authority,
    roles.semantic_permission_control,
    roles.semantic_private_authority_offers,
    roles.semantic_relay,
    roles.semantic_runtime,
    roles.semantic_schemas,
    roles.semantic_value_helpers
  ]) {
    const source = readRepositoryFile(repoRoot, repositoryPath);
    if (
      /(?:from\s+|export\s+\*\s+from\s+)"\.\/openclaw-[^"]+"/u.test(source)
    ) {
      fail(
        `Host-neutral authority must not import an OpenClaw adapter: ` +
        repositoryPath
      );
    }
  }
}

function validateOpenClawEntry(repoRoot, roles) {
  assertSourcePattern(
    repoRoot,
    roles.plugin_entry,
    new RegExp([
      String.raw`function createPlugin\s*\(`,
      String.raw`definePluginEntry\s*\(`,
      String.raw`export function createOpenClawPluginForTest\s*\(`,
      String.raw`export default plugin;`,
    ].join(String.raw`[\s\S]*?`), "u"),
    "OpenClaw plugin-entry role"
  );
  const entrySource = readRepositoryFile(repoRoot, roles.plugin_entry);
  if ((entrySource.match(/^export\s/gmu) ?? []).length !== 2) {
    fail("OpenClaw plugin-entry role must expose only default and test factory");
  }
  assertDirectNamedImport(
    repoRoot,
    roles.plugin_entry,
    "./openclaw-plugin-callback-adapter.js",
    ["registerOpenClawCallbackGateway"],
    "OpenClaw plugin-entry role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.plugin_entry,
    "./openclaw-plugin-command-adapter.js",
    [
      "bindOpenClawRelayPath",
      "defaultOpenClawRelayPath",
      "registerOpenClawCommands"
    ],
    "OpenClaw plugin-entry role"
  );
  assertDirectNamedImport(
    repoRoot,
    roles.plugin_entry,
    "./openclaw-plugin-supervisor.js",
    ["createMonitorReconciliationService", "MONITOR_SUPERVISOR_INTERVAL_MS"],
    "OpenClaw plugin-entry role"
  );
}

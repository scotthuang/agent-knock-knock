import {
  fail,
  assertExactKeys,
  assertString,
  assertExactArray,
  assertRepositoryPath,
  readJson,
  readRepositoryFile,
  validateAuthorityPaths,
  validateWitnessReferences,
  assertSourcePattern
} from "./common.js";
import {
  validateOpenClawAuthorityRoles
} from "./openclaw-authority.js";

const PUBLIC_CONTRACT_SCHEMA =
  "agent-knock-knock/public-contract-witnesses";

const PUBLIC_COMMANDS = Object.freeze([
  "delegate",
  "list",
  "watch-terminal",
  "watch-status",
  "unwatch-terminal",
  "status",
  "send",
  "new-thread",
  "clear-thread",
  "list-resumable-threads",
  "threads",
  "native-inspect",
  "native-status",
  "identify-foreground",
  "model-options",
  "repair-model-control",
  "set-model",
  "permission-options",
  "set-permissions",
  "resume-thread",
  "reconcile-binding",
  "respond",
  "respond-interaction",
  "approve",
  "cancel",
  "renew",
  "reconcile-monitors",
  "reconcile-watches",
  "close",
  "transcript",
  "install-openclaw",
  "doctor",
  "host-profile",
  "host-bridge",
  "callback",
  "retry-callback",
  "monitor"
]);

const PUBLIC_ACTIONS = Object.freeze([
  "send",
  "retry_submission",
  "watch",
  "unwatch",
  "new_thread",
  "list_resumable_threads",
  "native_inspect",
  "model_options",
  "repair_model_control",
  "set_model",
  "permission_options",
  "set_permissions",
  "identify_foreground",
  "identify_and_send",
  "resume_thread",
  "reconcile_binding",
  "respond",
  "respond_interaction",
  "status",
  "approve",
  "cancel",
  "renew",
  "retry_callback",
  "close"
]);

const OPENCLAW_TOOLS = Object.freeze([
  "agent_knock_knock_list",
  "agent_knock_knock_watch",
  "agent_knock_knock_unwatch",
  "agent_knock_knock_list_resumable_threads",
  "agent_knock_knock_native_inspect",
  "agent_knock_knock_model_options",
  "agent_knock_knock_repair_model_control",
  "agent_knock_knock_set_model",
  "agent_knock_knock_permission_options",
  "agent_knock_knock_set_permissions",
  "agent_knock_knock_identify_foreground",
  "agent_knock_knock_identify_and_send",
  "agent_knock_knock_new_thread",
  "agent_knock_knock_reconcile_binding",
  "agent_knock_knock_resume_thread",
  "agent_knock_knock_status",
  "agent_knock_knock_send",
  "agent_knock_knock_respond",
  "agent_knock_knock_respond_interaction",
  "agent_knock_knock_renew",
  "agent_knock_knock_retry_callback",
  "agent_knock_knock_cancel",
  "agent_knock_knock_close",
  "agent_knock_knock_approve"
]);

const HOST_BRIDGE_PROFILE_SCHEMA = "agent-knock-knock/host-profile";

const HOST_BRIDGE_PROFILE_SCHEMA_ID =
  "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/" +
  "schemas/host-profile-v1.schema.json";

const HOST_BRIDGE_AUTHORITY_PATHS = Object.freeze([
  "schemas/host-profile-v1.schema.json",
  "src/command-json-callback-transport.ts",
  "src/host-adapter-capabilities.ts",
  "src/host-adapter.ts",
  "src/host-bridge-mcp.ts",
  "src/host-bridge-tools.ts",
  "src/host-bridge.ts",
  "src/host-monitor-reconciliation.ts",
  "src/host-profile-callback-transport.ts",
  "src/host-profile-runtime.ts",
  "src/host-profile.ts",
  "src/semantic-permission-control.ts",
  "src/semantic-private-authority-offers.ts",
  "src/semantic-tool-arguments.ts",
  "src/semantic-tool-catalog.ts",
  "src/semantic-tool-command-helpers.ts",
  "src/semantic-tool-list-projection.ts",
  "src/semantic-tool-model-facing-field-policy.ts",
  "src/semantic-tool-presentation.ts",
  "src/semantic-tool-private-authority.ts",
  "src/semantic-tool-relay.ts",
  "src/semantic-tool-runtime.ts",
  "src/semantic-tool-schemas.ts",
  "src/semantic-tool-value-helpers.ts"
]);

const MIGRATION_IDS = Object.freeze([
  "callback-outbox",
  "cli-runtime",
  "lifecycle-transition",
  "monitor-seams",
  "mutation-lock-shell",
  "static-subprocess-final",
  "terminal-binding-authority",
  "terminal-dispatch-ledger",
  "terminal-dispatch-policy",
  "terminal-list-renderer",
  "verified-dead-agent"
]);

function validateWitnesses(value, { repoRoot, tiers }) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("public contract witnesses must be a non-empty array");
  }
  const witnesses = new Map();
  let previousId = "";
  for (const [index, valueEntry] of value.entries()) {
    const label = `public contract witness ${index}`;
    const entry = assertExactKeys(valueEntry, [
      "id",
      "needle",
      "path",
      "tier"
    ], label);
    const id = assertString(entry.id, `${label} id`);
    if (id <= previousId) {
      fail("public contract witnesses must be sorted by unique id");
    }
    previousId = id;
    const repositoryPath = assertRepositoryPath(entry.path, `${label} path`);
    if (!["fast", "integration"].includes(entry.tier)) {
      fail(`${label} tier must be fast or integration`);
    }
    if (!tiers[entry.tier].includes(repositoryPath)) {
      fail(`${label} path is not in the declared ${entry.tier} tier`);
    }
    const needle = assertString(entry.needle, `${label} needle`);
    if (!readRepositoryFile(repoRoot, repositoryPath).includes(needle)) {
      fail(`${label} needle is missing from ${repositoryPath}`);
    }
    witnesses.set(id, { ...entry, path: repositoryPath });
  }
  return witnesses;
}

function validatePublicContracts(value, {
  repoRoot,
  witnesses,
  usedWitnesses
}) {
  const contracts = assertExactKeys(value, [
    "cli_json",
    "host_bridge",
    "list_action",
    "openclaw_tools",
    "store_protocols"
  ], "public contracts");

  const context = { repoRoot, witnesses, usedWitnesses };
  validateCliContract(contracts, context);
  validateHostBridgeContract(contracts, context);
  validateListActionContract(contracts, context);
  validateOpenClawToolContract(contracts, context);
  validateStoreContract(contracts, context);
}

function validateMigrationMappings(value, { witnesses, usedWitnesses }) {
  if (!Array.isArray(value)) {
    fail("migration_witnesses must be an array");
  }
  const ids = [];
  for (const [index, valueEntry] of value.entries()) {
    const label = `migration witness mapping ${index}`;
    const entry = assertExactKeys(valueEntry, [
      "id",
      "invariant",
      "old_executable_witnesses",
      "retained_boundary_witnesses",
      "service_invariant_witnesses"
    ], label);
    ids.push(assertString(entry.id, `${label} id`));
    assertString(entry.invariant, `${label} invariant`);
    for (const [field, expectedTier] of [
      ["old_executable_witnesses", "integration"],
      ["service_invariant_witnesses", "fast"],
      ["retained_boundary_witnesses", "integration"]
    ]) {
      validateWitnessReferences(
        entry[field],
        `${label} ${field}`,
        witnesses,
        usedWitnesses
      );
      if (entry[field].length === 0) {
        fail(`${label} ${field} must not be empty`);
      }
      for (const witnessId of entry[field]) {
        if (witnesses.get(witnessId).tier !== expectedTier) {
          fail(`${label} ${field} witness ${witnessId} must be ${expectedTier}`);
        }
      }
    }
  }
  assertExactArray(ids, MIGRATION_IDS, "migration witness mapping ids");
}

export function validatePublicContractManifest({ manifest, repoRoot, tiers }) {
  const root = assertExactKeys(manifest, [
    "contracts",
    "migration_witnesses",
    "schema",
    "version",
    "witnesses"
  ], "public contract witness manifest");
  if (root.schema !== PUBLIC_CONTRACT_SCHEMA || root.version !== 1) {
    fail(`public contract manifest must use ${PUBLIC_CONTRACT_SCHEMA} version 1`);
  }
  const witnesses = validateWitnesses(root.witnesses, { repoRoot, tiers });
  const usedWitnesses = new Set();
  validatePublicContracts(root.contracts, {
    repoRoot,
    witnesses,
    usedWitnesses
  });
  validateMigrationMappings(root.migration_witnesses, {
    witnesses,
    usedWitnesses
  });
  const unused = [...witnesses.keys()].filter((id) => !usedWitnesses.has(id));
  if (unused.length > 0) {
    fail(`public contract witnesses are unreferenced: ${unused.join(", ")}`);
  }
  return {
    contractCount: Object.keys(root.contracts).length,
    witnessCount: witnesses.size,
    migrationCount: root.migration_witnesses.length,
    hostBridgeToolCount: root.contracts.host_bridge.tool_count,
    openclawToolCount: root.contracts.openclaw_tools.tools.length,
    storeProtocolCount: root.contracts.store_protocols.protocol_witnesses.length
  };
}

function validateCliContract(contracts, { repoRoot, witnesses, usedWitnesses }) {
  const cli = assertExactKeys(contracts.cli_json, [
    "authority_paths",
    "commands",
    "executable",
    "facade_exports",
    "package_name",
    "witnesses"
  ], "CLI JSON contract");
  if (cli.package_name !== "@scotthuang/agent-knock-knock" ||
      cli.executable !== "agent-knock-knock") {
    fail("CLI JSON package/executable contract changed");
  }
  assertExactArray(
    cli.facade_exports,
    ["parseCliCommand", "executeCliCommand"],
    "CLI JSON facade_exports"
  );
  assertExactArray(cli.commands, PUBLIC_COMMANDS, "CLI JSON commands");
  validateAuthorityPaths(cli.authority_paths, "CLI JSON authority_paths", repoRoot);
  validateWitnessReferences(
    cli.witnesses,
    "CLI JSON witnesses",
    witnesses,
    usedWitnesses
  );
  const packageJson = readJson(repoRoot, "package.json");
  if (packageJson.name !== cli.package_name ||
      packageJson.bin?.[cli.executable] !== "dist/src/cli.js") {
    fail("package.json no longer matches the CLI JSON package/executable contract");
  }
  assertSourcePattern(
    repoRoot,
    "src/cli-core.ts",
    /export function parseCliCommand\s*\(/u,
    "parseCliCommand facade export"
  );
  assertSourcePattern(
    repoRoot,
    "src/cli-core.ts",
    /export async function executeCliCommand\s*\(/u,
    "executeCliCommand facade export"
  );
}

function validateHostBridgeContract(contracts, { repoRoot, witnesses, usedWitnesses }) {
  const hostBridge = assertExactKeys(contracts.host_bridge, [
    "authority_paths",
    "callback_driver",
    "schema",
    "tool_count",
    "transport",
    "version",
    "witnesses"
  ], "Host Bridge contract");
  if (hostBridge.schema !== HOST_BRIDGE_PROFILE_SCHEMA ||
      hostBridge.version !== 1 ||
      hostBridge.transport !== "mcp_stdio" ||
      hostBridge.callback_driver !== "command_json_v1" ||
      hostBridge.tool_count !== OPENCLAW_TOOLS.length) {
    fail("Host Bridge profile, transport, callback, or tool contract changed");
  }
  assertExactArray(
    hostBridge.authority_paths,
    HOST_BRIDGE_AUTHORITY_PATHS,
    "Host Bridge authority_paths"
  );
  validateAuthorityPaths(
    hostBridge.authority_paths,
    "Host Bridge authority_paths",
    repoRoot
  );
  validateWitnessReferences(
    hostBridge.witnesses,
    "Host Bridge witnesses",
    witnesses,
    usedWitnesses
  );
  const hostProfileSchema = readJson(
    repoRoot,
    "schemas/host-profile-v1.schema.json"
  );
  if (hostProfileSchema.$id !== HOST_BRIDGE_PROFILE_SCHEMA_ID ||
      hostProfileSchema.properties?.$schema?.const !==
        HOST_BRIDGE_PROFILE_SCHEMA_ID ||
      hostProfileSchema.properties?.schema?.const !==
        HOST_BRIDGE_PROFILE_SCHEMA ||
      hostProfileSchema.properties?.version?.const !== 1 ||
      hostProfileSchema.$defs?.callback?.properties?.driver?.const !==
        "command_json_v1") {
    fail("Host Bridge JSON Schema no longer matches the v1 public contract");
  }
  assertSourcePattern(
    repoRoot,
    "src/host-bridge.ts",
    /new StdioServerTransport\(\s*input,\s*output\s*\)/u,
    "Host Bridge MCP stdio transport"
  );
}

function validateListActionContract(contracts, { repoRoot, witnesses, usedWitnesses }) {
  const actions = assertExactKeys(contracts.list_action, [
    "actions",
    "authority_paths",
    "version",
    "witnesses"
  ], "list action contract");
  if (actions.version !== 30) {
    fail("list action contract version must remain 30");
  }
  assertExactArray(actions.actions, PUBLIC_ACTIONS, "list action names");
  validateAuthorityPaths(
    actions.authority_paths,
    "list action authority_paths",
    repoRoot
  );
  validateWitnessReferences(
    actions.witnesses,
    "list action witnesses",
    witnesses,
    usedWitnesses
  );
  assertSourcePattern(
    repoRoot,
    "src/terminal-action-contracts.ts",
    /version:\s*30\b/u,
    "list action contract version 30"
  );
  assertSourcePattern(
    repoRoot,
    "src/terminal-action-contracts.ts",
    /export function listActionContracts\s*\(/u,
    "list action contract owner export"
  );
  assertSourcePattern(
    repoRoot,
    "src/terminal-list-renderer.ts",
    /export\s*\{\s*listActionContracts\s*\}\s*from "\.\/terminal-action-contracts\.js";/u,
    "list renderer public contract facade"
  );
}

function validateOpenClawToolContract(contracts, { repoRoot, witnesses, usedWitnesses }) {
  const openclaw = assertExactKeys(contracts.openclaw_tools, [
    "authority_paths",
    "plugin_id",
    "slash_command",
    "tools",
    "witnesses"
  ], "OpenClaw tool contract");
  if (openclaw.plugin_id !== "agent-knock-knock" ||
      openclaw.slash_command !== "akk") {
    fail("OpenClaw plugin id or slash command changed");
  }
  assertExactArray(openclaw.tools, OPENCLAW_TOOLS, "OpenClaw tools");
  validateOpenClawAuthorityRoles(openclaw.authority_paths, repoRoot);
  validateWitnessReferences(
    openclaw.witnesses,
    "OpenClaw witnesses",
    witnesses,
    usedWitnesses
  );
  const pluginManifest = readJson(repoRoot, "openclaw.plugin.json");
  if (pluginManifest.id !== openclaw.plugin_id ||
      pluginManifest.commandAliases?.[0]?.name !== openclaw.slash_command) {
    fail("openclaw.plugin.json no longer matches the plugin identity contract");
  }
  assertExactArray(
    pluginManifest.contracts?.tools,
    OPENCLAW_TOOLS,
    "openclaw.plugin.json contract tools"
  );
}

function validateStoreContract(contracts, { repoRoot, witnesses, usedWitnesses }) {
  const store = assertExactKeys(contracts.store_protocols, [
    "authority_paths",
    "current_writer_protocol",
    "format_version",
    "protocol_witnesses",
    "session_authority_protocol",
    "terminal_watch_schema",
    "terminal_watch_version",
    "upgradeable_writer_protocols",
    "witnesses"
  ], "Store protocol contract");
  if (store.format_version !== 1 ||
      store.current_writer_protocol !== 9 ||
      store.session_authority_protocol !== 3) {
    fail("Store format/writer/session-authority protocol contract changed");
  }
  if (store.terminal_watch_schema !== "agent-knock-knock/terminal-watch" ||
      store.terminal_watch_version !== 3) {
    fail("Terminal Watch schema contract changed");
  }
  assertExactArray(
    store.upgradeable_writer_protocols,
    [1, 2, 3, 4, 5, 6, 7, 8],
    "Store upgradeable_writer_protocols"
  );
  validateAuthorityPaths(store.authority_paths, "Store authority_paths", repoRoot);
  validateWitnessReferences(
    store.witnesses,
    "Store witnesses",
    witnesses,
    usedWitnesses
  );
  if (!Array.isArray(store.protocol_witnesses) ||
      store.protocol_witnesses.length !== 9) {
    fail("Store protocol_witnesses must cover writer protocols 1 through 9");
  }
  for (const [index, valueEntry] of store.protocol_witnesses.entries()) {
    const entry = assertExactKeys(valueEntry, ["protocol", "witness"],
      `Store protocol witness ${index}`);
    if (entry.protocol !== index + 1) {
      fail("Store protocol_witnesses must be ordered 1 through 9");
    }
    validateWitnessReferences(
      [entry.witness],
      `Store protocol ${entry.protocol} witness`,
      witnesses,
      usedWitnesses
    );
  }
  const storeSource = readRepositoryFile(repoRoot, "src/store.ts");
  for (const [name, expected] of [
    ["STORE_FORMAT_VERSION", 1],
    ["STORE_WRITER_PROTOCOL", 9],
    ["STORE_SESSION_AUTHORITY_PROTOCOL", 3]
  ]) {
    if (!new RegExp(`export const ${name} = ${expected};`, "u").test(storeSource)) {
      fail(`${name}=${expected} is missing from src/store.ts`);
    }
  }
  if (!/STORE_UPGRADEABLE_WRITER_PROTOCOLS = new Set\(\[1, 2, 3, 4, 5, 6, 7, 8\]\)/u
    .test(storeSource)) {
    fail("Store upgradeable writer protocol set changed");
  }
  assertSourcePattern(
    repoRoot,
    "src/terminal-watch-record.ts",
    /export const TERMINAL_WATCH_SCHEMA = "agent-knock-knock\/terminal-watch" as const;/u,
    "Terminal Watch schema v3 name"
  );
  assertSourcePattern(
    repoRoot,
    "src/terminal-watch-record.ts",
    /export const TERMINAL_WATCH_VERSION = 3 as const;/u,
    "Terminal Watch schema v3 version"
  );
}

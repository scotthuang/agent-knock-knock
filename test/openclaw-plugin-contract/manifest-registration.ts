import {
  test,
  assert,
  createHash,
  fs,
  path,
  plugin,
  assertNoModelOpaqueAuthority,
  packageRoot,
  readManifest,
  requiredName,
  requiredStringArray,
  sorted,
  type ContractTestApi,
  type Manifest,
  type ToolDefinition
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw branding uses the portable fixed icon asset", () => {
  const manifest = readManifest();
  assert.equal(Object.hasOwn(manifest, "icon"), false);

  const icon = fs.readFileSync(path.join(packageRoot, "assets", "icon.png"));
  const documentationIcon = fs.readFileSync(
    path.join(packageRoot, "docs", "assets", "agent-knock-knock-icon.png")
  );
  assert.deepEqual(icon, documentationIcon);
  assert.deepEqual(
    [...icon.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  ) as { files?: string[] };
  assert.ok(packageJson.files?.includes("assets/icon.png"));
});

test("OpenClaw runtime registrations match the published manifest", () => {
  const manifest = readManifest();
  const registeredCommands: string[] = [];
  const registeredTools: string[] = [];
  const toolDefinitions = new Map<string, ToolDefinition>();

  const api: ContractTestApi = {
    pluginConfig: {},
    logger: {
      info() {},
      warn() {}
    },
    registerGatewayMethod() {},
    registerService() {},
    registerCommand(command) {
      registeredCommands.push(requiredName(command.name, "runtime command"));
    },
    registerTool(tool, options) {
      const definition = typeof tool === "function" ? tool({}) : tool;
      const runtimeName = requiredName(definition.name, "runtime tool");
      const metadataName = requiredName(options?.name, "tool registration metadata");
      assert.equal(metadataName, runtimeName);
      registeredTools.push(runtimeName);
      toolDefinitions.set(runtimeName, definition);
    }
  };

  (
    plugin as unknown as {
      register(api: ContractTestApi): void;
    }
  ).register(api);

  for (const [name, definition] of toolDefinitions) {
    assertNoModelOpaqueAuthority(
      definition.parameters,
      `$.registeredTools.${name}.parameters`
    );
  }

  const contractedTools = requiredStringArray(
    manifest.contracts?.tools,
    "contracts.tools"
  );
  const activatedCommands = requiredStringArray(
    manifest.activation?.onCommands,
    "activation.onCommands"
  );
  const commandAliases = (manifest.commandAliases ?? []).map((alias) =>
    requiredName(alias.name, "command alias")
  );
  const metadataTools = Object.keys(manifest.toolMetadata ?? {});

  assert.deepEqual(sorted(registeredTools), sorted(contractedTools));
  assert.deepEqual(registeredTools, [
    "agent_knock_knock_list",
    "agent_knock_knock_watch",
    "agent_knock_knock_unwatch",
    "agent_knock_knock_list_resumable_threads",
    "agent_knock_knock_native_inspect",
    "agent_knock_knock_model_options",
    "agent_knock_knock_repair_model_control",
    "agent_knock_knock_set_model",
    "agent_knock_knock_identify_foreground",
    "agent_knock_knock_identify_and_send",
    "agent_knock_knock_new_thread",
    "agent_knock_knock_reconcile_binding",
    "agent_knock_knock_resume_thread",
    "agent_knock_knock_status",
    "agent_knock_knock_send",
    "agent_knock_knock_respond",
    "agent_knock_knock_respond_interaction",
    "agent_knock_knock_approve",
    "agent_knock_knock_renew",
    "agent_knock_knock_retry_callback",
    "agent_knock_knock_cancel",
    "agent_knock_knock_close"
  ]);
  const schemaBytes = JSON.stringify(
    registeredTools.map((name) => [name, toolDefinitions.get(name)?.parameters])
  );
  assert.equal(
    createHash("sha256").update(schemaBytes).digest("hex"),
    "0e47c461753a7a71c988f1436b14b186047f220d74ed474ca655251cd6538f67"
  );
  assert.deepEqual(sorted(metadataTools), sorted(contractedTools));
  assert.equal(contractedTools.length, 22);
  assert.match(
    manifest.description ?? "",
    /closed native status inspection/u
  );
  assert.deepEqual(
    sorted(registeredCommands),
    sorted(activatedCommands)
  );

  const listTool = toolDefinitions.get("agent_knock_knock_list");
  assert.ok(listTool);
  assert.match(listTool.description ?? "", /compact projection/u);
  assert.match(listTool.description ?? "", /available_actions/u);
  assert.match(listTool.description ?? "", /action_inputs/u);
  assert.match(listTool.description ?? "", /agent-knock-knock skill/u);
  assert.match(listTool.description ?? "", /privately revalidates/u);
  assert.ok(
    (listTool.description ?? "").length < 500,
    "static List semantics belong in the bundled skill"
  );
  assert.doesNotMatch(listTool.description ?? "", /follow_up/u);
  assert.doesNotMatch(
    listTool.description ?? "",
    /delegated|terminal_controlled|tasks\[\]/u
  );
  assert.equal(
    Object.hasOwn(listTool.parameters?.properties ?? {}, "managedOnly"),
    false
  );
  assert.deepEqual(
    sorted(commandAliases),
    sorted(registeredCommands)
  );
  assert.equal(contractedTools.includes("agent_knock_knock_send"), true);
  assert.equal(contractedTools.includes("agent_knock_knock_respond"), true);
  assert.equal(
    contractedTools.includes("agent_knock_knock_respond_interaction"),
    true
  );
  assert.equal(contractedTools.includes("agent_knock_knock_watch"), true);
  assert.equal(contractedTools.includes("agent_knock_knock_unwatch"), true);
  assert.equal(
    contractedTools.includes("agent_knock_knock_list_resumable_threads"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_native_inspect"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_model_options"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_repair_model_control"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_set_model"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_identify_foreground"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_identify_and_send"),
    true
  );
  assert.equal(contractedTools.includes("agent_knock_knock_new_thread"), true);
  assert.equal(
    contractedTools.includes("agent_knock_knock_reconcile_binding"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_resume_thread"),
    true
  );
  for (const removedTool of [
    "agent_knock_knock_delegate",
    "agent_knock_knock_describe",
    "agent_knock_knock_agent_takeover"
  ]) {
    assert.equal(contractedTools.includes(removedTool), false);
  }
  const configProperties = (
    readManifest() as Manifest & {
      configSchema?: { properties?: Record<string, unknown> };
    }
  ).configSchema?.properties ?? {};
  assert.equal("defaultAgent" in configProperties, false);
  assert.equal("workspace" in configProperties, false);
});

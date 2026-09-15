import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  createHostBridgeToolRegistry
} from "../src/host-bridge-tools.js";
import {
  registerOpenClawCommands
} from "../src/openclaw-plugin-command-adapter.js";
import {
  createAkkSemanticToolCatalog
} from "../src/semantic-tool-runtime.js";

type ToolMetadata = {
  name: string;
  label?: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
};

test("semantic catalog freezes the exact ordered tool metadata digest", () => {
  const catalog = createAkkSemanticToolCatalog(runtime(), new Map());
  const schemaBytes = JSON.stringify(
    catalog.tools.map((tool) => [tool.name, tool.inputSchema])
  );
  assert.equal(
    createHash("sha256").update(schemaBytes).digest("hex"),
    "0e47c461753a7a71c988f1436b14b186047f220d74ed474ca655251cd6538f67"
  );
  assert.equal(
    publicMetadataDigest(catalog.command, catalog.tools),
    "f469d4e7320c789a48ca106e3a89a5f81815d4da7c14920bfd11d25fdf598a98"
  );
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.command), true);
  assert.equal(Object.isFrozen(catalog.command.promptGuidance), true);
  assert.equal(Object.isFrozen(catalog.tools), true);
  assert.equal(catalog.tools.every(Object.isFrozen), true);
});

test("OpenClaw registration and Host Bridge consume one catalog byte-for-byte", () => {
  const openClawTools: ToolMetadata[] = [];
  let openClawCommand: Record<string, unknown> | undefined;
  const api = {
    ...runtime(),
    registerCommand(command: Record<string, unknown>) {
      openClawCommand = command;
    },
    registerTool(
      factory: (context: object) => Record<string, unknown>,
      registration: { name: string }
    ) {
      const definition = factory({
        sessionKey: "openclaw-owner",
        sessionId: "openclaw-incarnation"
      });
      assert.equal(registration.name, definition.name);
      openClawTools.push({
        name: String(definition.name),
        label: String(definition.label),
        description: String(definition.description),
        inputSchema: definition.parameters as Readonly<Record<string, unknown>>
      });
    }
  };
  registerOpenClawCommands(api, new Map());

  const host = createHostBridgeToolRegistry({
    relayPath: new URL("../src/cli.js", import.meta.url).pathname,
    relayEnvironment: {},
    pluginConfig: {},
    logger: logger(),
    context: {
      sessionKey: "host-owner",
      sessionId: "host-incarnation"
    }
  });
  const hostTools = host.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
  assert.deepEqual(
    hostTools,
    openClawTools.map(({ label: _label, ...tool }) => tool)
  );
  assert.deepEqual(
    {
      name: host.command().name,
      description: host.command().description,
      acceptsArgs: host.command().acceptsArgs
    },
    {
      name: openClawCommand?.name,
      description: openClawCommand?.description,
      acceptsArgs: openClawCommand?.acceptsArgs
    }
  );
});

test("OpenClaw and Host Bridge consume the same host-neutral runtime factory", () => {
  const hostSource = fs.readFileSync("src/host-bridge-tools.ts", "utf8");
  const openClawSource = fs.readFileSync(
    "src/openclaw-plugin-command-adapter.ts",
    "utf8"
  );
  const runtimeSource = fs.readFileSync(
    "src/semantic-tool-runtime.ts",
    "utf8"
  );
  const relaySource = fs.readFileSync(
    "src/semantic-tool-relay.ts",
    "utf8"
  );
  assert.doesNotMatch(hostSource, /registerOpenClawCommands/u);
  assert.doesNotMatch(hostSource, /openclaw-plugin-command-adapter/u);
  assert.doesNotMatch(hostSource, /\bregister(?:Command|Tool)\s*\(/u);
  assert.match(hostSource, /createAkkSemanticToolCatalog/u);
  assert.match(hostSource, /from "\.\/semantic-tool-relay\.js"/u);
  assert.match(openClawSource, /createAkkSemanticToolCatalog/u);
  assert.match(openClawSource, /registerSemanticToolCatalog/u);
  assert.doesNotMatch(runtimeSource, /registerOpenClawCommands/u);
  assert.doesNotMatch(runtimeSource, /registerSemanticToolCatalog/u);
  assert.doesNotMatch(runtimeSource, /node:(?:async_hooks|child_process)/u);
  assert.match(runtimeSource, /from "\.\/semantic-tool-relay\.js"/u);
  assert.doesNotMatch(relaySource, /openclaw-plugin-command-adapter/u);
  assert.doesNotMatch(relaySource, /openclaw-plugin-(?:helpers|schemas)/u);

  for (const sourcePath of [
    "connectors/pi/src/index.ts",
    "connectors/deepseek-harness/src/index.ts"
  ]) {
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.match(source, /\bcreateHostAdapter\b/u, sourcePath);
    assert.match(source, /\.tools\b/u, sourcePath);
    assert.doesNotMatch(source, /name:\s*["']agent_knock_knock_/u, sourcePath);
  }
});

function publicMetadataDigest(
  command: {
    readonly name: string;
    readonly description: string;
    readonly acceptsArgs: boolean;
  },
  tools: readonly ToolMetadata[]
): string {
  return createHash("sha256").update(JSON.stringify({
    command: [command.name, command.description, command.acceptsArgs],
    tools: tools.map((tool) => [
      tool.name,
      tool.description,
      tool.inputSchema
    ])
  })).digest("hex");
}

function runtime() {
  return {
    pluginConfig: {},
    logger: logger()
  };
}

function logger() {
  return {
    info() {},
    warn() {}
  };
}

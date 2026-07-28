import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../src/openclaw-plugin.js";

type Manifest = {
  activation?: {
    onCommands?: string[];
  };
  commandAliases?: Array<{
    name?: string;
  }>;
  contracts?: {
    tools?: string[];
  };
  skills?: string[];
  toolMetadata?: Record<string, unknown>;
};

type ToolDefinition = {
  name?: string;
};

type ToolFactory = (context: Record<string, never>) => ToolDefinition;

type ContractTestApi = {
  pluginConfig: Record<string, never>;
  logger: {
    info(): void;
    warn(): void;
  };
  registerGatewayMethod(...args: unknown[]): void;
  registerService(service: unknown): void;
  registerCommand(command: { name?: string }): void;
  registerTool(
    tool: ToolDefinition | ToolFactory,
    options?: {
      name?: string;
      optional?: boolean;
    }
  ): void;
};

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const manifestPath = path.join(packageRoot, "openclaw.plugin.json");

test("OpenClaw runtime registrations match the published manifest", () => {
  const manifest = readManifest();
  const registeredCommands: string[] = [];
  const registeredTools: string[] = [];

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
    }
  };

  (
    plugin as unknown as {
      register(api: ContractTestApi): void;
    }
  ).register(api);

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
  assert.deepEqual(sorted(metadataTools), sorted(contractedTools));
  assert.deepEqual(
    sorted(registeredCommands),
    sorted(activatedCommands)
  );
  assert.deepEqual(
    sorted(commandAliases),
    sorted(registeredCommands)
  );
});

test("bundled OpenClaw skills exist and are included in the npm artifact", () => {
  const manifest = readManifest();
  const skillPaths = requiredStringArray(manifest.skills, "skills");

  for (const skillPath of skillPaths) {
    assert.equal(path.isAbsolute(skillPath), false, `${skillPath} must be relative`);
    const skillRoot = path.resolve(packageRoot, skillPath);
    assert.equal(
      path.relative(packageRoot, skillRoot).startsWith(".."),
      false,
      `${skillPath} must stay inside the package`
    );
    assert.equal(
      fs.existsSync(path.join(skillRoot, "SKILL.md")),
      true,
      `${skillPath} must contain SKILL.md`
    );
  }

  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const result = JSON.parse(packed.stdout) as Array<{
    files?: Array<{
      path?: string;
    }>;
  }>;
  const packedFiles = new Set(
    (result[0]?.files ?? [])
      .map((file) => file.path)
      .filter((file): file is string => typeof file === "string")
  );

  for (const skillPath of skillPaths) {
    assert.equal(
      packedFiles.has(path.posix.join(skillPath, "SKILL.md")),
      true,
      `${skillPath}/SKILL.md must be included by npm pack`
    );
  }
  for (const documentationPath of [
    "README.md",
    "docs/quickstart-tmux.md",
    "docs/quickstart-managed-acpx.md",
    "scripts/smoke-acpx.js",
    "scripts/smoke-tmux.js"
  ]) {
    assert.equal(
      packedFiles.has(documentationPath),
      true,
      `${documentationPath} must be included for ClawHub rendering and first-run help`
    );
  }
});

test("/akk doctor leaves the Gateway event loop free for its health check", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-doctor-"));
  const fakeCli = path.join(tempDir, "doctor.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({
      ok: true,
      selected_mode: "tmux",
      capabilities: {
        tmux: { checked: true, status: "ready" },
        acpx: { checked: false, status: "partially_ready" }
      },
      openclaw: {
        package_ready: true,
        gateway_ready: true,
        checks: []
      }
    }));
  });

  try {
    fs.writeFileSync(
      fakeCli,
      `const http = require("node:http");
const request = http.get(process.env.AKK_TEST_DOCTOR_URL, (response) => {
  response.pipe(process.stdout);
  response.on("end", () => process.exit(0));
});
request.setTimeout(1000, () => {
  request.destroy();
  process.exit(3);
});
request.on("error", () => process.exit(4));
`,
      "utf8"
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const previousUrl = process.env.AKK_TEST_DOCTOR_URL;
    process.env.AKK_TEST_DOCTOR_URL =
      `http://127.0.0.1:${(address as { port: number }).port}/health`;

    try {
      (
        plugin as unknown as {
          register(api: Record<string, any>): void;
        }
      ).register({
        pluginConfig: { binPath: fakeCli },
        logger: {
          info() {},
          warn() {}
        },
        registerGatewayMethod() {},
        registerService() {},
        registerCommand(value: typeof command) {
          command = value;
        },
        registerTool() {}
      });

      assert.equal(typeof command?.handler, "function");
      const result = await command?.handler?.({
        args: "doctor tmux",
        sessionKey: "agent:main:main"
      });
      assert.match(result?.text ?? "", /AKK doctor: ready/u);
      assert.notEqual(result?.isError, true);
    } finally {
      if (previousUrl === undefined) {
        delete process.env.AKK_TEST_DOCTOR_URL;
      } else {
        process.env.AKK_TEST_DOCTOR_URL = previousUrl;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

function requiredName(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must have a name`);
  assert.notEqual(value, "", `${label} name must not be empty`);
  return value as string;
}

function requiredStringArray(value: unknown, label: string): string[] {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
  assert.notEqual((value as unknown[]).length, 0, `${label} must not be empty`);
  for (const item of value as unknown[]) {
    assert.equal(typeof item, "string", `${label} entries must be strings`);
    assert.notEqual(item, "", `${label} entries must not be empty`);
  }
  return value as string[];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

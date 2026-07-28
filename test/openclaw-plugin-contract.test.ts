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
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    details?: Record<string, unknown>;
  }>;
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

type GatewayMethodHandler = (context: {
  params: unknown;
  respond(
    ok: boolean,
    result?: unknown,
    error?: {
      code?: string;
      message?: string;
    }
  ): void;
}) => Promise<void>;

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

test("OpenClaw delegate returns tmux conversation storage paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-delegate-paths-"));
  const fakeCli = path.join(tempDir, "delegate.cjs");
  const statePath = path.join(tempDir, "state.json");
  const eventLogPath = path.join(tempDir, "events.ndjson");
  let delegateTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const result = ${JSON.stringify({
          conversation: {
            conversation_id: "managed-terminal-1",
            status: "waiting_for_agent",
            state_path: statePath,
            event_log_path: eventLogPath,
            executor: {
              kind: "codex",
              session: "terminal:v2:tmux:codex:work:0.0:123"
            }
          },
          terminal_control: {
            target: "work:0.0",
            panePid: 123
          },
          delivered: true,
          background: true
        })};`,
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n")
    );

    (
      plugin as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        binPath: fakeCli,
        workspace: tempDir
      },
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({ sessionKey: "agent:test:main" } as never)
          : tool;
        if (options?.name === "agent_knock_knock_delegate") {
          delegateTool = definition;
        }
      }
    });

    assert.equal(typeof delegateTool?.execute, "function");
    const result = await delegateTool?.execute?.("tool-call-1", {
      request: "Verify the delegate output contract",
      agent: "codex"
    });
    assert.equal(result?.details?.state_path, statePath);
    assert.equal(result?.details?.event_log_path, eventLogPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    "docs/quickstart-tmux.md"
  ]) {
    assert.equal(
      packedFiles.has(documentationPath),
      true,
      `${documentationPath} must be included for ClawHub rendering and first-run help`
    );
  }
});

test("callback delivery uses the grouped OpenClaw session workflow API", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedInjection: Record<string, unknown> | undefined;
  let response:
    | {
        ok: boolean;
        result?: Record<string, unknown>;
        error?: {
          code?: string;
          message?: string;
        };
      }
    | undefined;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: {
      info() {},
      warn() {}
    },
    session: {
      workflow: {
        async enqueueNextTurnInjection(
          injection: Record<string, unknown>
        ) {
          capturedInjection = injection;
          return {
            enqueued: true,
            id: "injection-1",
            sessionKey: injection.sessionKey
          };
        }
      }
    },
    registerGatewayMethod(
      method: string,
      handler: GatewayMethodHandler
    ) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "compat-1",
        openclaw_session: "agent:main:compat"
      },
      message: {
        id: "message-1",
        conversation_id: "compat-1",
        type: "progress",
        requires_response: false,
        round: 1,
        body: "Compatibility callback"
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.error, undefined);
  assert.equal(response?.result?.enqueued, true);
  assert.equal(response?.result?.delivery_required, false);
  assert.equal(response?.result?.session_key, "agent:main:compat");
  assert.deepEqual(capturedInjection, {
    sessionKey: "agent:main:compat",
    text: [
      "[Agent Knock Knock callback]",
      "Conversation: compat-1",
      "Message type: progress",
      "Requires OpenClaw response: no",
      "Round: 1",
      "Compatibility callback"
    ].join("\n"),
    idempotencyKey: "agent-knock-knock:compat-1:message-1",
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: "compat-1",
      message_id: "message-1",
      message_type: "progress",
      state_path: undefined,
      log_path: undefined
    }
  });
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
      capabilities: {
        tmux: { checked: true, status: "ready" }
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
        args: "doctor",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

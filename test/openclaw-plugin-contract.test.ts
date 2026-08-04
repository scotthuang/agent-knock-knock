import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin, {
  createOpenClawPluginForTest
} from "../src/openclaw-plugin.js";

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
  description?: string;
  parameters?: {
    additionalProperties?: boolean;
    required?: string[];
    anyOf?: Array<{ required?: string[] }>;
    not?: { required?: string[] };
    properties?: Record<string, unknown>;
  };
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    details?: Record<string, unknown>;
    isError?: boolean;
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

  const listTool = toolDefinitions.get("agent_knock_knock_list");
  assert.ok(listTool);
  assert.match(listTool.description ?? "", /terminals\[\]/u);
  assert.match(listTool.description ?? "", /managed\.current_turn/u);
  assert.match(listTool.description ?? "", /respond targets the exact in-flight turn/u);
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

test("OpenClaw routing and reconciliation omit a global workspace argument", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-send-paths-"));
  const fakeCli = path.join(tempDir, "delegate.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const eventLogPath = path.join(tempDir, "events.ndjson");
  let sendTool: ToolDefinition | undefined;
  let respondTool: ToolDefinition | undefined;
  let reconciliationService: { start?(): void } | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `const result = ${JSON.stringify({
          conversation: {
            conversation_id: "turn-1",
            session_id: "session-1",
            turn_id: "turn-1",
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
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService(service: { start?(): void }) {
        reconciliationService = service;
      },
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({ sessionKey: "agent:test:main" } as never)
          : tool;
        if (options?.name === "agent_knock_knock_send") {
          sendTool = definition;
        }
        if (options?.name === "agent_knock_knock_respond") {
          respondTool = definition;
        }
      }
    });

    assert.equal(typeof sendTool?.execute, "function");
    assert.equal(sendTool?.parameters?.additionalProperties, false);
    assert.deepEqual(sendTool?.parameters?.required, ["request"]);
    assert.deepEqual(sendTool?.parameters?.not, {
      required: ["session_id", "selector"]
    });
    assert.equal(
      "timeoutSeconds" in (sendTool?.parameters?.properties ?? {}),
      false
    );
    const sendTypeSchema = sendTool?.parameters?.properties?.type;
    assert.deepEqual(
      isRecord(sendTypeSchema) ? sendTypeSchema.enum : undefined,
      ["task"]
    );
    for (const field of ["session_id", "selector", "request"]) {
      const schema = sendTool?.parameters?.properties?.[field];
      assert.equal(
        isRecord(schema) ? schema.minLength : undefined,
        1,
        `${field} must reject empty strings at the schema boundary`
      );
    }
    const idleTimeoutSchema = sendTool?.parameters?.properties?.idleTimeoutMinutes;
    assert.match(
      isRecord(idleTimeoutSchema)
        ? String(idleTimeoutSchema.description ?? "")
        : "",
      /idle or completed AKK Turn record is retained/u
    );
    assert.match(sendTool?.description ?? "", /timeoutSeconds is unsupported/u);
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-answer", {
        request: "Do not route this as an ordinary send",
        type: "answer"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-control", {
        session_id: "session-1",
        request: "Do not route this control message",
        type: "control"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-ambiguous-target", {
        session_id: "session-1",
        selector: "@a1b2c3d4",
        request: "Do not choose one target silently"
      }),
      /only one of session_id or selector/u
    );
    for (const [field, value] of [
      ["session_id", ""],
      ["session_id", "   "],
      ["selector", ""],
      ["selector", "   "]
    ] as const) {
      await assert.rejects(
        () => sendTool!.execute!(`tool-call-empty-${field}`, {
          [field]: value,
          request: "Never fall back to automatic terminal selection"
        }),
        new RegExp(`${field} is required`, "u")
      );
    }
    const result = await sendTool?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    assert.equal(result?.details?.state_path, statePath);
    assert.equal(result?.details?.event_log_path, eventLogPath);
    assert.equal(result?.details?.session_id, "session-1");
    assert.equal(result?.details?.turn_id, "turn-1");
    await sendTool?.execute?.("tool-call-2", {
      session_id: "session-1",
      request: "Start a distinct turn"
    });
    await sendTool?.execute?.("tool-call-3", {
      selector: "@a1b2c3d4",
      request: "Discover the initial terminal"
    });
    assert.deepEqual(respondTool?.parameters?.required, ["turn_id", "request"]);
    const respondResult = await respondTool?.execute?.("tool-call-4", {
      turn_id: "turn-1",
      request: "Use the safer implementation"
    });
    assert.equal(respondResult?.details?.session_id, "session-1");
    assert.equal(respondResult?.details?.turn_id, "turn-1");
    assert.equal(typeof reconciliationService?.start, "function");
    reconciliationService?.start?.();
    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls[0]?.[0], "delegate");
    assert.equal(calls[0]?.includes("--agent"), false);
    assert.equal(calls[0]?.includes("--workspace"), false);
    assert.deepEqual(calls[1]?.slice(0, 5), [
      "send",
      "--session",
      "session-1",
      "--message",
      "Start a distinct turn"
    ]);
    assert.equal(calls[1]?.includes("--workspace"), false);
    assert.deepEqual(calls[2]?.slice(0, 5), [
      "send",
      "--conversation",
      "@a1b2c3d4",
      "--message",
      "Discover the initial terminal"
    ]);
    assert.deepEqual(calls[3]?.slice(0, 5), [
      "respond",
      "--turn",
      "turn-1",
      "--message",
      "Use the safer implementation"
    ]);
    assert.equal(calls[4]?.[0], "reconcile-monitors");
    assert.equal(calls[4]?.includes("--workspace"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw controls distinguish managed turns from list-prefilled raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-turn-controls-"));
  const fakeCli = path.join(tempDir, "controls.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write("{}");`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_approve",
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const definition = tools.get(name);
      assert.ok(definition, `${name} must be registered`);
      assert.ok(definition.parameters?.properties?.turn_id);
      assert.ok(definition.parameters?.properties?.conversation_id);
      assert.deepEqual(definition.parameters?.anyOf, [
        { required: ["turn_id"] },
        { required: ["conversation_id"] }
      ]);
      assert.deepEqual(definition.parameters?.not, {
        required: ["turn_id", "conversation_id"]
      });
    }
    assert.equal(
      Object.hasOwn(
        tools.get("agent_knock_knock_send")?.parameters?.properties ?? {},
        "turn_id"
      ),
      false
    );
    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_approve",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const conversationSchema = tools.get(name)?.parameters?.properties
        ?.conversation_id;
      const description = isRecord(conversationSchema)
        ? String(conversationSchema.description ?? "")
        : "";
      assert.match(description, /raw-terminal|raw terminal/u, name);
      assert.match(description, /never construct|never guess/u, name);
    }

    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_approve",
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      await assert.rejects(
        () => tools.get(name)!.execute!("ambiguous-turn-target", {
          turn_id: "turn-modern",
          conversation_id: "turn-legacy-other",
          ...(name === "agent_knock_knock_approve"
            ? { expected_approval_fingerprint: "fingerprint-ambiguous" }
            : {})
        }),
        /only one of turn_id or conversation_id/u,
        name
      );
    }

    await tools.get("agent_knock_knock_status")?.execute?.("status", {
      turn_id: "turn-status"
    });
    await tools.get("agent_knock_knock_approve")?.execute?.("approve", {
      conversation_id: "legacy-turn",
      expected_approval_fingerprint: "fingerprint-1"
    });
    await tools.get("agent_knock_knock_renew")?.execute?.("renew", {
      turn_id: "turn-renew"
    });
    await tools.get("agent_knock_knock_retry_callback")?.execute?.("retry", {
      turn_id: "turn-retry"
    });
    await tools.get("agent_knock_knock_cancel")?.execute?.("cancel", {
      turn_id: "turn-cancel"
    });
    await tools.get("agent_knock_knock_close")?.execute?.("close", {
      turn_id: "turn-close"
    });

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args.slice(0, 4)), [
      ["status", "--reconcile", "--turn", "turn-status"],
      ["approve", "--conversation", "legacy-turn", "--expected-approval-fingerprint"],
      ["renew", "--turn", "turn-renew"],
      ["retry-callback", "--turn", "turn-retry"],
      ["cancel", "--turn", "turn-cancel"],
      ["close", "--turn", "turn-close"]
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw status includes purpose context and a bounded terminal screen", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-status-"));
  const fakeCli = path.join(tempDir, "status.cjs");
  let statusTool: ToolDefinition | undefined;
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const result = {
  conversation_id: "managed-terminal-1",
  session_id: "session-status",
  turn_id: "managed-terminal-1",
  summary: {
    conversation_id: "managed-terminal-1",
    session_id: "session-status",
    turn_id: "managed-terminal-1",
    agent: "codex",
    status: "waiting_for_agent",
    session: "work:0.0"
  },
  about: "Review the current branch",
  confidence: "high",
  limitations: ["history is bounded"],
  terminal_screen: {
    excerpt: "Running focused tests"
  }
};
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { workspace: tempDir },
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name === "agent_knock_knock_status") {
          statusTool = definition;
        }
      }
    });

    const toolResult = await statusTool?.execute?.("tool-call-status", {
      conversation_id: "only"
    });
    assert.equal(toolResult?.details?.about, "Review the current branch");
    assert.equal(toolResult?.details?.confidence, "high");
    assert.deepEqual(toolResult?.details?.limitations, ["history is bounded"]);

    const slashResult = await command?.handler?.({
      args: "status only",
      sessionKey: "agent:test:main"
    });
    assert.match(slashResult?.text ?? "", /about: Review the current branch/u);
    assert.match(slashResult?.text ?? "", /terminal screen:\nRunning focused tests/u);
    assert.match(slashResult?.text ?? "", /^session: session-status$/mu);
    assert.match(slashResult?.text ?? "", /^turn: managed-terminal-1$/mu);
    assert.doesNotMatch(slashResult?.text ?? "", /^conversation:/mu);
    assert.doesNotMatch(slashResult?.text ?? "", /work:0\.0/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public command results label AKK sessions and turns instead of native sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-public-wording-"));
  const fakeCli = path.join(tempDir, "public-wording.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const turnId = \`turn-\${action}\`;
const sessionId = \`session-\${action}\`;
const conversation = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  status: action === "close" ? "closed" : "waiting_for_agent",
  executor: { kind: "codex", session: \`native-\${action}\` }
};
const result = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  conversation,
  summary: {
    conversation_id: turnId,
    session_id: sessionId,
    turn_id: turnId,
    agent: "codex",
    status: conversation.status,
    session: \`native-summary-\${action}\`
  },
  executor: conversation.executor,
  terminal_control: { target: \`native-pane-\${action}\` },
  delivered: true,
  background: true,
  approved: action === "approve",
  cancel_requested: action === "cancel",
  agent_timeout_minutes: 20,
  agent_hard_timeout_minutes: 120
};
if (action === "retry-callback") {
  delete result.session_id;
  delete result.turn_id;
  delete result.conversation.session_id;
  delete result.conversation.turn_id;
  delete result.summary.session_id;
  delete result.summary.turn_id;
  result.conversation.callback_delivery = { attempts: 2 };
}
process.stdout.write(JSON.stringify(result));
`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool() {}
    });

    const cases = [
      {
        args: "Review public wording",
        action: "delegate",
        sessionId: "session-delegate",
        turnId: "turn-delegate"
      },
      {
        args: "status turn-status",
        action: "status",
        sessionId: "session-status",
        turnId: "turn-status"
      },
      {
        args: "renew turn-renew 20",
        action: "renew",
        sessionId: "session-renew",
        turnId: "turn-renew"
      },
      {
        args: "retry-callback turn-retry-callback",
        action: "retry-callback",
        sessionId: "turn-retry-callback",
        turnId: "turn-retry-callback"
      },
      {
        args: "cancel turn-cancel",
        action: "cancel",
        sessionId: "session-cancel",
        turnId: "turn-cancel"
      },
      {
        args: "approve turn-approve --expected-approval-fingerprint fingerprint-1",
        action: "approve",
        sessionId: "session-approve",
        turnId: "turn-approve"
      },
      {
        args: "close turn-close done",
        action: "close",
        sessionId: "session-close",
        turnId: "turn-close"
      }
    ];

    for (const item of cases) {
      const result = await command?.handler?.({
        args: item.args,
        sessionKey: "agent:test:public-wording"
      });
      const text = String(result?.text ?? "");
      assert.match(text, new RegExp(`^session: ${item.sessionId}$`, "mu"), item.action);
      assert.match(text, new RegExp(`^turn: ${item.turnId}$`, "mu"), item.action);
      assert.doesNotMatch(text, /^conversation:/mu, item.action);
      assert.doesNotMatch(text, /native-/u, item.action);
    }

    const closeResult = await command?.handler?.({
      args: "close turn-close done",
      sessionKey: "agent:test:public-wording"
    });
    assert.match(closeResult?.text ?? "", /AKK Turn record closed\./u);
    assert.doesNotMatch(closeResult?.text ?? "", /AKK session closed/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw surfaces delivered-but-unfenced sends as errors that must not be retried", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-unfenced-"));
  const fakeCli = path.join(tempDir, "unfenced.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        conversation_id: "turn-unfenced",
        session_id: "session-unfenced",
        turn_id: "turn-unfenced",
        status: "delivered_unfenced",
        submission_outcome: "submitted",
        do_not_retry: true,
        reason: "native identity did not bind",
        conversation: {
          conversation_id: "turn-unfenced",
          session_id: "session-unfenced",
          turn_id: "turn-unfenced",
          status: "stalled",
          executor: { kind: "codex", session: "native-unfenced" }
        }
      }))});`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({ sessionKey: "agent:test:unfenced" } as never)
            : tool;
        }
      },
      registerCommand(value: typeof command) {
        command = value;
      }
    });

    for (const args of [
      "Inspect the repository",
      "codex: Inspect the repository"
    ]) {
      const result = await command?.handler?.({
        args,
        sessionKey: "agent:test:unfenced"
      });
      assert.equal(result?.isError, true, args);
      assert.match(result?.text ?? "", /could not bind|could not fence/u, args);
      assert.match(result?.text ?? "", /do not retry/u, args);
      assert.doesNotMatch(result?.text ?? "", /yield now/u, args);
    }

    assert.equal(typeof sendTool?.execute, "function");
    const toolResponse = await sendTool?.execute?.("unfenced-send", {
      request: "Inspect the repository"
    });
    assert.equal(toolResponse?.isError, true);
    assert.equal(toolResponse?.details?.status, "submission_unfenced");
    assert.equal(toolResponse?.details?.do_not_retry, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin tool results reject partial identity and do not invent Turn ids for raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-result-identity-"));
  const fakeCli = path.join(tempDir, "identity.cjs");
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const result = action === "status"
  ? { source: "terminal_control", conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
  : { conversation: { conversation_id: "turn-partial", session_id: "session-partial" } };
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    await assert.rejects(
      () => tools.get("agent_knock_knock_send")!.execute!("partial", {
        session_id: "session-partial",
        request: "Do not expose partial identity"
      }),
      /partial session_id\/turn_id identity/u
    );
    const rawStatus = await tools.get("agent_knock_knock_status")?.execute?.(
      "raw-status",
      { conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
    );
    assert.equal(rawStatus?.details?.conversation_id,
      "terminal:v2:tmux:codex:work:0.0:123");
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "session_id"), false);
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "turn_id"), false);
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
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      conversation: {
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        gateway_session: "agent:main:compat",
        openclaw_session: "agent:main:origin"
      },
      message: {
        id: "message-1",
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        type: "progress",
        requires_response: false,
        round: 1,
        body: "Compatibility callback",
        metadata: {
          conversation_id: "turn-1",
          session_id: "session-1",
          turn_id: "turn-1"
        }
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
  assert.equal(response?.result?.session_id, "session-1");
  assert.equal(response?.result?.turn_id, "turn-1");
  assert.deepEqual(capturedInjection, {
    sessionKey: "agent:main:compat",
    text: [
      "[Agent Knock Knock callback]",
      "Session: session-1",
      "Turn: turn-1",
      "Message type: progress",
      "Requires OpenClaw response: no",
      "Round: 1",
      "Compatibility callback"
    ].join("\n"),
    idempotencyKey: "agent-knock-knock:session-1:turn-1:message-1",
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      message_type: "progress",
      state_path: undefined,
      log_path: undefined
    }
  });

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2"
      },
      message: {
        id: "message-done",
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2",
        type: "done",
        requires_response: false,
        round: 1,
        body: "All focused tests passed"
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
  const doneText = String(capturedInjection?.text ?? "");
  const doneResult = (
    response as { result?: Record<string, unknown> } | undefined
  )?.result;
  assert.equal(doneResult?.session_id, "session-1");
  assert.equal(doneResult?.turn_id, "turn-2");
  assert.equal(doneResult?.delivery_required, true);
  assert.match(doneText, /Session: session-1/u);
  assert.match(doneText, /Turn: turn-2/u);
  assert.match(doneText, /agent_knock_knock_send/u);
  assert.match(doneText, /session_id: "session-1"/u);
  assert.match(doneText, /agent_knock_knock_status/u);
  assert.match(doneText, /turn_id: "turn-2"/u);
  assert.doesNotMatch(doneText, /follow_up/u);
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:session-1:turn-2:message-done"
  );
  const chatSend = isRecord(doneResult?.chat_send)
    ? doneResult.chat_send
    : undefined;
  assert.equal(
    chatSend?.idempotencyKey,
    "agent-knock-knock-callback:session-1:turn-2:message-done"
  );

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "legacy-callback-3"
      },
      message: {
        id: "message-legacy",
        conversation_id: "legacy-callback-3",
        type: "done",
        requires_response: false,
        round: 1,
        body: "Legacy callback identity"
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
  const legacyResponse = response as
    | { ok: boolean; result?: Record<string, unknown> }
    | undefined;
  assert.equal(legacyResponse?.ok, true);
  assert.equal(legacyResponse?.result?.conversation_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.session_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.turn_id, "legacy-callback-3");
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:legacy-callback-3:message-legacy"
  );
  assert.equal(
    (legacyResponse?.result?.chat_send as Record<string, unknown> | undefined)
      ?.idempotencyKey,
    "agent-knock-knock-callback:legacy-callback-3:message-legacy"
  );
});

test("callback rejects conflicting identities before injection or dedupe", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let injectionCalls = 0;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection() {
          injectionCalls += 1;
          return { enqueued: true };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  const validParams = () => ({
    sessionKey: "agent:main:identity-check",
    conversation_id: "turn-safe",
    session_id: "session-safe",
    turn_id: "turn-safe",
    conversation: {
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      openclaw_session: "agent:main:identity-check"
    },
    message: {
      id: "message-safe",
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      type: "done",
      requires_response: false,
      round: 1,
      body: "Identity-safe callback",
      metadata: {
        conversation_id: "turn-safe",
        session_id: "session-safe",
        turn_id: "turn-safe",
        openclaw_session: "agent:main:identity-check"
      }
    }
  });
  const cases: Array<{
    name: string;
    mutate(params: ReturnType<typeof validParams>): void;
    error: RegExp;
  }> = [
    {
      name: "conflicting top-level session",
      mutate(params) {
        params.session_id = "session-other";
      },
      error: /session_id mismatch/u
    },
    {
      name: "conflicting metadata turn",
      mutate(params) {
        params.message.metadata.turn_id = "turn-other";
      },
      error: /turn_id mismatch/u
    },
    {
      name: "conflicting message conversation",
      mutate(params) {
        params.message.conversation_id = "turn-other";
      },
      error: /conversation_id mismatch/u
    },
    {
      name: "modern conversation id differs from turn id",
      mutate(params) {
        params.conversation_id = "compat-other";
        params.conversation.conversation_id = "compat-other";
        params.message.conversation_id = "compat-other";
        params.message.metadata.conversation_id = "compat-other";
      },
      error: /conversation_id must equal turn_id/u
    },
    {
      name: "modern identity is missing session id",
      mutate(params) {
        delete (params as any).session_id;
        delete (params.conversation as any).session_id;
        delete (params.message as any).session_id;
        delete (params.message.metadata as any).session_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing turn id",
      mutate(params) {
        delete (params as any).turn_id;
        delete (params.conversation as any).turn_id;
        delete (params.message as any).turn_id;
        delete (params.message.metadata as any).turn_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing the conversation alias",
      mutate(params) {
        delete (params as any).conversation_id;
        delete (params.conversation as any).conversation_id;
        delete (params.message as any).conversation_id;
        delete (params.message.metadata as any).conversation_id;
      },
      error: /require conversation_id/u
    },
    {
      name: "callback has no identity",
      mutate(params) {
        for (const field of ["conversation_id", "session_id", "turn_id"]) {
          delete (params as any)[field];
          delete (params.conversation as any)[field];
          delete (params.message as any)[field];
          delete (params.message.metadata as any)[field];
        }
      },
      error: /callback identity requires/u
    },
    {
      name: "OpenClaw session targets conflict",
      mutate(params) {
        params.conversation.openclaw_session = "agent:other:session";
      },
      error: /session mismatch/u
    },
    {
      name: "OpenClaw identity sources conflict",
      mutate(params) {
        params.message.metadata.openclaw_session = "agent:other:session";
      },
      error: /OpenClaw session mismatch/u
    },
    {
      name: "callback message id is missing",
      mutate(params) {
        delete (params.message as any).id;
      },
      error: /message.id is required/u
    }
  ];

  for (const mismatch of cases) {
    let callbackResponse:
      | {
          ok: boolean;
          error?: { code?: string; message?: string };
        }
      | undefined;
    await callbackHandler?.({
      params: (() => {
        const params = validParams();
        mismatch.mutate(params);
        return params;
      })(),
      respond(ok, _result, error) {
        callbackResponse = { ok, ...(error ? { error } : {}) };
      }
    });
    assert.equal(callbackResponse?.ok, false, mismatch.name);
    assert.equal(
      callbackResponse?.error?.code,
      "AGENT_KNOCK_KNOCK_CALLBACK_FAILED",
      mismatch.name
    );
    assert.match(callbackResponse?.error?.message ?? "", mismatch.error, mismatch.name);
    assert.equal(injectionCalls, 0, mismatch.name);
  }
});

test("callback auto approval keeps its rule workspace boundary without global workspace config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-autoapprove-workspace-"));
  const allowedWorkspace = path.join(tempDir, "allowed");
  const outsideWorkspace = path.join(tempDir, "outside");
  const fakeCli = path.join(tempDir, "approve.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const policy = {
    enabled: true,
    rules: [{
      id: "allowed-status",
      agents: ["codex"],
      workspaces: [allowedWorkspace],
      commands: [["git", "status"]]
    }]
  };
  let callbackHandler: GatewayMethodHandler | undefined;
  const injections: Record<string, unknown>[] = [];

  try {
    fs.mkdirSync(allowedWorkspace, { recursive: true });
    fs.mkdirSync(outsideWorkspace, { recursive: true });
    fs.writeFileSync(
      fakeCli,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write(${JSON.stringify(JSON.stringify({
          approved: true,
          policy_rule_id: "allowed-status",
          monitor_pid: 71
        }))});`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        autoApprove: policy
      },
      logger: {
        info() {},
        warn() {}
      },
      session: {
        workflow: {
          async enqueueNextTurnInjection(
            injection: Record<string, unknown>
          ) {
            injections.push(injection);
            return {
              enqueued: true,
              id: `injection-${injections.length}`,
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
    const invokeApprovalCallback = async (
      messageId: string,
      cwd: string
    ) => {
      let callbackResponse:
        | {
            ok: boolean;
            result?: Record<string, any>;
            error?: { code?: string; message?: string };
          }
        | undefined;
      await callbackHandler?.({
        params: {
          sessionKey: "agent:test:autoapprove",
          statePath,
          conversation: {
            conversation_id: "autoapprove-workspace",
            openclaw_session: "agent:test:autoapprove"
          },
          message: {
            id: messageId,
            conversation_id: "autoapprove-workspace",
            type: "question",
            requires_response: true,
            body: "Codex needs approval",
            metadata: {
              source: "terminal_bridge",
              reason: "approval_required",
              approval_candidate: {
                agent: "codex",
                kind: "run_command",
                command: "git status",
                cwd,
                fingerprint: `fingerprint-${messageId}`,
                terminal_target: "codex-work:0.0"
              }
            }
          }
        },
        respond(ok, result, error) {
          callbackResponse = {
            ok,
            ...(isRecord(result) ? { result } : {}),
            ...(error ? { error } : {})
          };
        }
      });
      assert.notEqual(callbackResponse, undefined);
      return callbackResponse!;
    };

    const approved = await invokeApprovalCallback(
      "approval-allowed",
      allowedWorkspace
    );
    assert.equal(approved.ok, true);
    assert.equal(approved.result?.auto_approved, true);
    assert.equal(approved.result?.enqueued, false);
    assert.equal(injections.length, 0);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "approve");
    assert.equal(calls[0]?.includes("--workspace"), false);
    const policyIndex = calls[0]?.indexOf("--auto-approval-policy-json") ?? -1;
    assert.notEqual(policyIndex, -1);
    assert.deepEqual(
      JSON.parse(calls[0]?.[policyIndex + 1] ?? "{}"),
      policy
    );

    const outside = await invokeApprovalCallback(
      "approval-outside",
      outsideWorkspace
    );
    assert.equal(outside.ok, true);
    assert.equal(outside.result?.auto_approved, undefined);
    assert.equal(outside.result?.enqueued, true);
    assert.equal(injections.length, 1);
    assert.equal(
      fs.readFileSync(callsPath, "utf8").trim().split("\n").length,
      1,
      "an out-of-rule workspace must not execute the approval CLI"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
        createOpenClawPluginForTest(fakeCli) as unknown as {
          register(api: Record<string, any>): void;
        }
      ).register({
        pluginConfig: {},
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

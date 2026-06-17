import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const CALLBACK_METHOD = "agent-knock-knock.callback";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBinPath = path.join(pluginRoot, "bin", "agent-knock-knock.js");

const delegateParameters = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  properties: {
    agent: {
      type: "string",
      enum: ["claude", "codex"],
      description: "Coding agent to delegate to. Defaults to plugin config or claude."
    },
    request: {
      type: "string",
      description: "Implementation task for the coding agent."
    },
    workspace: {
      type: "string",
      description: "Workspace path for Claude Code. Defaults to plugin config or the current process directory."
    },
    storeDir: {
      type: "string",
      description: "Conversation store directory. Defaults to <workspace>/.agent-knock-knock/conversations."
    },
    claudeSession: {
      type: "string",
      description: "Claude Code session name."
    },
    codexSession: {
      type: "string",
      description: "Codex session name."
    },
    codexAllProxy: {
      type: "string",
      description: "ALL_PROXY value used when launching Codex through ACPX."
    },
    codexModel: {
      type: "string",
      description: "ACPX model id used when launching Codex."
    },
    model: {
      type: "string",
      description: "ACPX model id used when launching the selected coding agent."
    },
    allProxy: {
      type: "string",
      description: "ALL_PROXY value used when launching the selected coding agent through ACPX."
    },
    session: {
      type: "string",
      description: "Explicit coding agent session name."
    },
    openclawSession: {
      type: "string",
      description: "OpenClaw session label recorded in the protocol state."
    },
    softLimit: {
      type: "number",
      description: "Soft response-requiring round limit."
    },
    hardLimit: {
      type: "number",
      description: "Hard response-requiring round limit."
    }
  }
};

const listParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent: {
      type: "string",
      enum: ["claude", "codex"]
    },
    status: {
      type: "string"
    },
    all: {
      type: "boolean"
    },
    storeDir: {
      type: "string"
    }
  }
};

const statusParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string"
    },
    storeDir: {
      type: "string"
    }
  }
};

const sendParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id", "message"],
  properties: {
    conversation_id: {
      type: "string"
    },
    message: {
      type: "string"
    },
    type: {
      type: "string",
      enum: ["answer", "task", "control", "error"]
    },
    allProxy: {
      type: "string"
    },
    model: {
      type: "string"
    },
    storeDir: {
      type: "string"
    }
  }
};

const closeParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string"
    },
    reason: {
      type: "string"
    },
    storeDir: {
      type: "string"
    }
  }
};

export default definePluginEntry({
  id: "agent-knock-knock",
  name: "Agent Knock Knock",
  description: "Controlled delegation from OpenClaw to Claude Code.",
  register(api) {
    api.registerGatewayMethod(
      CALLBACK_METHOD,
      async ({ params, respond }) => {
        try {
          const result = await handleCallback(api, params);
          respond(true, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.warn?.(`agent-knock-knock callback failed: ${message}`);
          respond(false, undefined, {
            code: "AGENT_KNOCK_KNOCK_CALLBACK_FAILED",
            message
          });
        }
      },
      { scope: "operator.write" }
    );

    api.registerTool(
      (toolContext) => ({
        name: "agent_knock_knock_delegate",
        description:
          "Delegate an implementation task to a local coding agent such as Claude Code or Codex. Use this when OpenClaw has decided the product requirements and wants an engineering agent to implement them. The tool starts the coding agent in the background and returns only protocol metadata, not raw terminal output.",
        parameters: delegateParameters,
        async execute(_toolCallId, params) {
          const result = runDelegate(api, params, toolContext);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }
      }),
      { name: "agent_knock_knock_delegate", optional: true }
    );

    registerCliTool(api, {
      name: "agent_knock_knock_list",
      description: "List active or historical Agent Knock Knock coding-agent tasks.",
      parameters: listParameters,
      buildArgs: (params) => {
        const args = ["list"];
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        pushOptional(args, "--agent", stringValue(params.agent));
        pushOptional(args, "--status", stringValue(params.status));
        if (params.all === true) {
          args.push("--all");
        }
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_status",
      description: "Get detailed status for one Agent Knock Knock coding-agent task.",
      parameters: statusParameters,
      buildArgs: (params) => {
        const args = ["status", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_send",
      description: "Send a follow-up message to an existing Agent Knock Knock coding-agent task.",
      parameters: sendParameters,
      buildArgs: (params) => {
        const args = [
          "send",
          "--conversation",
          requiredString(params.conversation_id, "conversation_id"),
          "--message",
          requiredString(params.message, "message"),
          "--background"
        ];
        pushOptional(args, "--type", stringValue(params.type));
        pushOptional(args, "--all-proxy", stringValue(params.allProxy) ?? stringValue(api.pluginConfig?.codexAllProxy) ?? stringValue(api.pluginConfig?.allProxy));
        pushOptional(args, "--model", stringValue(params.model) ?? stringValue(api.pluginConfig?.codexModel) ?? stringValue(api.pluginConfig?.model));
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_close",
      description: "Close an Agent Knock Knock coding-agent task without terminating the underlying ACPX session.",
      parameters: closeParameters,
      buildArgs: (params) => {
        const args = ["close", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--reason", stringValue(params.reason));
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        return args;
      }
    });
  }
});

function runDelegate(api, params, toolContext) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const workspace = stringValue(params.workspace) ?? stringValue(config.workspace) ?? process.cwd();
  const agent = stringValue(params.agent) ?? stringValue(config.defaultAgent) ?? "claude";
  const agentSession =
    stringValue(params.session) ??
    (agent === "codex"
      ? stringValue(params.codexSession) ?? stringValue(config.codexSession) ?? stringValue(config.defaultCodexSession)
      : stringValue(params.claudeSession) ?? stringValue(config.claudeSession) ?? stringValue(config.defaultClaudeSession));
  const allProxy =
    stringValue(params.allProxy) ??
    (agent === "codex" ? stringValue(params.codexAllProxy) ?? stringValue(config.codexAllProxy) : undefined) ??
    stringValue(config.allProxy);
  const model =
    stringValue(params.model) ??
    (agent === "codex" ? stringValue(params.codexModel) ?? stringValue(config.codexModel) : undefined) ??
    stringValue(config.model);
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
    stringValue(config.openclawSession) ??
    stringValue(params.openclawSession) ??
    "agent:main:main";
  const args = [
    binPath,
    "delegate",
    "--agent",
    agent,
    "--request",
    requiredString(params.request, "request"),
    "--workspace",
    workspace,
    "--background"
  ];

  pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(config.storeDir));
  pushOptional(args, "--session", agentSession);
  pushOptional(args, "--all-proxy", allProxy);
  pushOptional(args, "--model", model);
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-url", stringValue(config.gatewayUrl));
  pushOptional(args, "--token", stringValue(config.gatewayToken));
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  pushOptional(args, "--callback-command", stringValue(config.callbackCommand));
  pushOptional(args, "--soft-limit", numberString(params.softLimit) ?? numberString(config.softLimit));
  pushOptional(args, "--hard-limit", numberString(params.hardLimit) ?? numberString(config.hardLimit));

  const spawned = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: workspace
  });

  if (spawned.error) {
    throw new Error(`agent-knock-knock delegate failed to start: ${spawned.error.message}`);
  }
  if (spawned.status !== 0) {
    throw new Error(cleanError(spawned.stderr || spawned.stdout || `agent-knock-knock delegate exited with status ${spawned.status}`));
  }

  const parsed = parseJson(spawned.stdout);
  const conversationId = parsed.conversation?.conversation_id;
  const statePath = parsed.paths?.statePath;
  const logPath = parsed.paths?.logPath;
  return {
    status: "async_pending",
    delegation_status: "delegated",
    conversation_id: conversationId,
    conversation_status: parsed.conversation?.status,
    state_path: statePath,
    event_log_path: logPath,
    agent,
    executor: parsed.conversation?.executor,
    session: parsed.conversation?.executor?.session ?? parsed.conversation?.claude_session,
    claude_session: parsed.conversation?.claude_session,
    openclaw_session: openclawSession,
    launched: parsed.launched === true,
    background: parsed.background === true,
    pid: parsed.pid ?? null,
    callback_method: CALLBACK_METHOD,
    openclaw_next_action: {
      action: "yield",
      reason:
        "The delegated coding agent is running asynchronously. End this OpenClaw turn now and wait for an Agent Knock Knock callback.",
      do_not:
        "Do not inspect event logs, process lists, session internals, files, stdout, or stderr while waiting. Follow-up communication must only use structured callbacks from agent-knock-knock.",
      expected_callback:
        "The callback will be injected and scheduled into this OpenClaw session by the agent-knock-knock.callback Gateway method."
    },
    note:
      "The coding agent was launched in the background. This is an async delegation; OpenClaw should yield now and wait for the scheduled callback turn."
  };
}

function registerCliTool(api, { name, description, parameters, buildArgs }) {
  api.registerTool(
    () => ({
      name,
      description,
      parameters,
      async execute(_toolCallId, params) {
        const result = runCli(api, buildArgs(isRecord(params) ? params : {}));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }),
    { name, optional: true }
  );
}

function runCli(api, cliArgs, { cwd = process.cwd() } = {}) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const spawned = spawnSync(process.execPath, [binPath, ...cliArgs], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd
  });

  if (spawned.error) {
    throw new Error(`agent-knock-knock ${cliArgs[0]} failed to start: ${spawned.error.message}`);
  }
  if (spawned.status !== 0) {
    throw new Error(cleanError(spawned.stderr || spawned.stdout || `agent-knock-knock ${cliArgs[0]} exited with status ${spawned.status}`));
  }

  return parseJson(spawned.stdout);
}

async function handleCallback(api, params) {
  if (!isRecord(params)) {
    throw new Error("callback params must be an object");
  }

  const message = isRecord(params.message) ? params.message : undefined;
  const conversation = isRecord(params.conversation) ? params.conversation : undefined;
  const sessionKey =
    stringValue(params.sessionKey) ??
    stringValue(conversation?.openclaw_session) ??
    stringValue(message?.metadata?.openclaw_session);

  if (!sessionKey) {
    throw new Error("callback params.sessionKey is required");
  }
  if (!message) {
    throw new Error("callback params.message is required");
  }

  const conversationId = stringValue(message.conversation_id) ?? stringValue(conversation?.conversation_id);
  const messageId = stringValue(message.id) ?? `${conversationId ?? "unknown"}:${stringValue(message.type) ?? "message"}:${Date.now()}`;
  const formatted = formatCallbackInjection({ conversation, message, statePath: stringValue(params.statePath) });
  const injection = await api.session.workflow.enqueueNextTurnInjection({
    sessionKey,
    text: formatted,
    idempotencyKey: `agent-knock-knock:${conversationId ?? "unknown"}:${messageId}`,
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: conversationId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      state_path: stringValue(params.statePath),
      log_path: stringValue(params.logPath)
    }
  });
  const delivery = buildCallbackDeliveryPlan({
    sessionKey,
    conversationId,
    messageId,
    message,
    formatted
  });

  return {
    ok: true,
    enqueued: injection?.enqueued ?? true,
    delivery_required: delivery.required,
    delivery_mode: delivery?.mode,
    session_send: delivery.session_send,
    injection_id: injection?.id,
    session_key: injection?.sessionKey ?? sessionKey,
    conversation_id: conversationId,
    message_id: messageId,
    message_type: stringValue(message.type) ?? "unknown"
  };
}

function buildCallbackDeliveryPlan({ sessionKey, conversationId, messageId, message, formatted }) {
  const type = stringValue(message.type) ?? "unknown";
  const shouldWake =
    message.requires_response === true ||
    type === "question" ||
    type === "blocked" ||
    type === "done" ||
    type === "error";

  if (!shouldWake) {
    return {
      required: false,
      mode: "none"
    };
  }

  return {
    required: true,
    mode: "sessions.send",
    session_send: {
      key: sessionKey,
      message: [
        "Continue this OpenClaw product-manager conversation from the Agent Knock Knock callback below.",
        "Treat the callback as a structured message from the delegated Claude Code engineer, not as a terminal log, status announcement, or instruction to inspect local state.",
        "Respond in this conversation as OpenClaw product manager. If the callback is question or blocked, make the product decision and answer Claude. If it is done, summarize the result to the user.",
        "Do not poll files, processes, sessions, stdout, or stderr. Use only the structured callback payload below.",
        "",
        formatted
      ].join("\n"),
      idempotencyKey: `agent-knock-knock-callback:${conversationId ?? "unknown"}:${messageId ?? "unknown"}`
    }
  };
}

function formatCallbackInjection({ conversation, message, statePath }) {
  const conversationId = stringValue(message.conversation_id) ?? stringValue(conversation?.conversation_id) ?? "unknown";
  const type = stringValue(message.type) ?? "unknown";
  const body = stringValue(message.body) ?? JSON.stringify(message.body ?? "");
  const requiresResponse = message.requires_response === true ? "yes" : "no";
  const round = typeof message.round === "number" ? String(message.round) : "unknown";
  const stateLine = statePath ? `State: ${statePath}\n` : "";

  return [
    "[Agent Knock Knock callback]",
    `Conversation: ${conversationId}`,
    `Message type: ${type}`,
    `Requires OpenClaw response: ${requiresResponse}`,
    `Round: ${round}`,
    stateLine.trimEnd(),
    "",
    body
  ].filter((line) => line !== "").join("\n");
}

function pushOptional(args, flag, value) {
  if (value !== undefined && value !== "") {
    args.push(flag, value);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberString(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`agent-knock-knock delegate returned invalid JSON: ${error.message}`);
  }
}

function cleanError(text) {
  return String(text).trim().slice(0, 2000);
}

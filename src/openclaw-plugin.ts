import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  EXECUTOR_KINDS,
  executorDefinitionForAlias,
  executorDefinitionForKind,
  parseLeadingExecutorAlias
} from "./executors.js";

const CALLBACK_METHOD = "agent-knock-knock.callback";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultBinPath = path.join(pluginRoot, "dist", "src", "cli.js");

const delegateParameters = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  properties: {
    agent: {
      type: "string",
      enum: EXECUTOR_KINDS,
      description:
        "Coding agent to delegate to. Defaults to plugin config defaultAgent, falling back to codex when unset. Explicit user agent requests override the default."
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
    cursorSession: {
      type: "string",
      description: "Cursor session name."
    },
    codexAllProxy: {
      type: "string",
      description: "ALL_PROXY value used when launching Codex through ACPX."
    },
    cursorAllProxy: {
      type: "string",
      description: "ALL_PROXY value used when launching Cursor through ACPX."
    },
    codexModel: {
      type: "string",
      description: "ACPX model id used when launching Codex."
    },
    cursorModel: {
      type: "string",
      description: "ACPX model id used when launching Cursor."
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
    },
    idleTimeoutMinutes: {
      type: "number",
      description: "Minutes an idle AKK session remains open before lazy cleanup closes it."
    },
    agentTimeoutMinutes: {
      type: "number",
      description: "Minutes AKK waits for a coding-agent callback before marking the task stalled."
    }
  }
};

const listParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    agent: {
      type: "string",
      enum: EXECUTOR_KINDS
    },
    status: {
      type: "string"
    },
    all: {
      type: "boolean"
    },
    storeDir: {
      type: "string"
    },
    idleTimeoutMinutes: {
      type: "number"
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
    },
    idleTimeoutMinutes: {
      type: "number"
    },
    agentTimeoutMinutes: {
      type: "number"
    },
    trace: {
      type: "boolean",
      description: "Include a safe executor trace summary with tool calls, permission requests, monitor events, and redacted thinking markers."
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
    },
    idleTimeoutMinutes: {
      type: "number"
    }
  }
};

const cancelParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string"
    },
    allProxy: {
      type: "string"
    },
    storeDir: {
      type: "string"
    },
    idleTimeoutMinutes: {
      type: "number"
    }
  }
};

const recoveryParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string"
    },
    session: {
      type: "string"
    },
    allProxy: {
      type: "string"
    },
    model: {
      type: "string"
    },
    storeDir: {
      type: "string"
    },
    idleTimeoutMinutes: {
      type: "number"
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

const agentDiscoverParameters = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "scope"],
  properties: {
    agent: {
      type: "string",
      enum: ["codex"],
      description: "Local coding agent session provider to inspect. Currently supports Codex."
    },
    scope: {
      type: "string",
      enum: ["capabilities", "sessions", "active"],
      description: "Discovery scope: provider capabilities, historical sessions, or active local CLI processes."
    },
    codexHome: {
      type: "string",
      description: "Optional Codex home directory. Defaults to ~/.codex."
    }
  }
};

const agentTakeoverParameters = {
  type: "object",
  additionalProperties: false,
  required: ["agent", "sessionId", "strategy"],
  properties: {
    agent: {
      type: "string",
      enum: ["codex"],
      description: "Local coding agent session provider to plan takeover for. Currently supports Codex."
    },
    sessionId: {
      type: "string",
      description: "Native Codex session id to inspect or take over."
    },
    strategy: {
      type: "string",
      enum: ["safe_resume", "terminate_then_resume", "fork"],
      description:
        "Takeover strategy. safe_resume only works when no matching CLI is active. terminate_then_resume returns a confirmation plan to stop the exact active CLI before resume. fork returns bounded context for OpenClaw summary confirmation."
    },
    createConversation: {
      type: "boolean",
      description:
        "When true and the selected strategy is ready, create an AKK-managed conversation bound to the native session so later AKK send/status/close can use it."
    },
    confirmTerminate: {
      type: "boolean",
      description:
        "Only for strategy=terminate_then_resume. When true, AKK will terminate the exact expected Codex CLI pid after rechecking that it still matches the requested session, then create the AKK conversation."
    },
    expectedPid: {
      type: "number",
      description:
        "Required with confirmTerminate=true. The exact Codex CLI pid from the previous takeover plan that the user confirmed may be terminated."
    },
    allowCwdOnly: {
      type: "boolean",
      description:
        "Only for strategy=terminate_then_resume with confirmTerminate=true. Allows terminating the expected pid when Codex does not expose a session id in argv, as long as the pid still runs in the target session cwd. Use only after explaining the higher risk to the user."
    },
    request: {
      type: "string",
      description: "Optional user-visible request label stored on the created AKK conversation."
    },
    forkSummary: {
      type: "string",
      description:
        "Required when strategy=fork and createConversation=true. OpenClaw-approved summary of the bounded source context to inject into the new forked AKK session."
    },
    storeDir: {
      type: "string",
      description: "Conversation store directory. Defaults to plugin config or <workspace>/.agent-knock-knock/conversations."
    },
    openclawSession: {
      type: "string",
      description: "OpenClaw session label recorded in the created AKK conversation."
    },
    codexHome: {
      type: "string",
      description: "Optional Codex home directory. Defaults to ~/.codex."
    },
    maxMessages: {
      type: "number",
      description: "Maximum rollout messages to include for fork context."
    },
    maxCommands: {
      type: "number",
      description: "Maximum rollout command records to include for fork context."
    },
    maxTextLength: {
      type: "number",
      description: "Maximum text length per fork-context message."
    }
  }
};

export default definePluginEntry({
  id: "agent-knock-knock",
  name: "Agent Knock Knock",
  description:
    "Agent Knock Knock (AKK/akk) delegates OpenClaw coding work to local Codex, Claude, or Cursor agents. Use this for AKK, akk, Agent Knock Knock, Codex delegation, Claude delegation, Cursor delegation, task listing, follow-up messages, status, recovery, restart, cancel requests, and close requests. Default delegation target comes from plugin config defaultAgent and falls back to Codex when unset; explicit user agent requests override it.",
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

    api.registerCommand?.({
      name: "akk",
      description: "Delegate coding work to Agent Knock Knock, list tasks, send follow-ups, cancel running work, and close tasks.",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: {
        default: "AKK is handling the request..."
      },
      agentPromptGuidance: [
        "Use /akk <task> to delegate coding work to Agent Knock Knock. /akk uses the plugin-configured defaultAgent and falls back to Codex when unset; use /akk claude <task>, /akk cursor <task>, or /akk codex <task> when the user explicitly requests that agent."
      ],
      handler: async (ctx) => handleAkkCommand(api, ctx)
    });

    api.registerTool(
      (toolContext) => ({
        name: "agent_knock_knock_delegate",
        description:
          "Delegate an implementation task to a local coding agent. Use this when the user says AKK, akk, Agent Knock Knock, asks to hand work to Codex, Claude, or Cursor, or asks OpenClaw to start a background coding-agent task. If the user says AKK without an explicit agent, omit the agent parameter so the plugin-configured defaultAgent is used, falling back to Codex when unset. The tool starts the coding agent in the background and returns only protocol metadata, not raw terminal output.",
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
      description: "List open or historical Agent Knock Knock coding-agent sessions. Use this for AKK list, akk list, current AKK tasks, or asking which Codex/Claude/Cursor sessions are open. Idle sessions are complete for now but can receive follow-up sends until they are closed or time out.",
      parameters: listParameters,
      buildArgs: (params) => {
        const args = ["list"];
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
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
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        if (params.trace === true) {
          args.push("--trace");
        }
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_send",
      description: "Send a follow-up message to an existing open Agent Knock Knock coding-agent session. Use this for AKK follow-up requests such as sending another instruction to an idle, waiting, or running Codex, Claude, or Cursor session.",
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
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(api.pluginConfig?.agentTimeoutMinutes));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_cancel",
      description: "Request cooperative cancellation of the current in-flight prompt for an existing Agent Knock Knock Codex, Claude, or Cursor session. This does not close the AKK session; use close when the session should no longer be reused.",
      parameters: cancelParameters,
      buildArgs: (params) => {
        const args = ["cancel", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--all-proxy", stringValue(params.allProxy) ?? stringValue(api.pluginConfig?.codexAllProxy) ?? stringValue(api.pluginConfig?.allProxy));
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_recover",
      description: "Recover an Agent Knock Knock task whose coding-agent session is unavailable by starting a new session with AKK's saved protocol history summary plus the pending message. Use only after the user chooses recovery.",
      parameters: recoveryParameters,
      buildArgs: (params) => buildRecoveryArgs(api, "recover", params)
    });

    registerCliTool(api, {
      name: "agent_knock_knock_restart",
      description: "Restart an Agent Knock Knock task whose coding-agent session is unavailable by starting a new session with only the pending message. Use only after the user chooses restart instead of history recovery.",
      parameters: recoveryParameters,
      buildArgs: (params) => buildRecoveryArgs(api, "restart", params)
    });

    registerCliTool(api, {
      name: "agent_knock_knock_close",
      description: "Close an Agent Knock Knock coding-agent task without terminating the underlying ACPX session. Use this for AKK close requests.",
      parameters: closeParameters,
      buildArgs: (params) => {
        const args = ["close", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--reason", stringValue(params.reason));
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_agent_discover",
      description:
        "Discover native local coding-agent sessions managed outside AKK. Use this to inspect Codex provider capabilities, historical Codex sessions, or active Codex CLI processes before taking over an existing local session.",
      parameters: agentDiscoverParameters,
      buildArgs: (params) => {
        const args = [
          "agent",
          "discover",
          "--agent",
          requiredString(params.agent, "agent"),
          "--scope",
          requiredString(params.scope, "scope")
        ];
        pushOptional(args, "--codex-home", stringValue(params.codexHome) ?? stringValue(api.pluginConfig?.codexHome));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_agent_takeover",
      description:
        "Build or execute a takeover plan for an existing native local coding-agent session. Use this for AKK takeover requests. By default it is side-effect-free and returns the plan; with createConversation=true it can attach a ready native session or create a confirmed forked AKK-managed conversation. For terminate_then_resume, only call with confirmTerminate=true and expectedPid after the user explicitly confirms stopping that exact Codex CLI pid. If Codex does not expose a session id, allowCwdOnly=true is a higher-risk explicit-pid fallback.",
      parameters: agentTakeoverParameters,
      buildArgs: (params, toolContext) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const openclawSession =
          stringValue(toolContext?.sessionKey) ??
          stringValue(config.openclawSession) ??
          stringValue(params.openclawSession) ??
          "agent:main:main";
        const args = [
          "agent",
          "takeover",
          "--agent",
          requiredString(params.agent, "agent"),
          "--session-id",
          requiredString(params.sessionId, "sessionId"),
          "--strategy",
          requiredString(params.strategy, "strategy")
        ];
        if (params.createConversation === true) {
          args.push("--create-conversation");
        }
        if (params.confirmTerminate === true) {
          args.push("--confirm-terminate");
        }
        if (params.allowCwdOnly === true) {
          args.push("--allow-cwd-only");
        }
        pushOptional(args, "--expected-pid", numberString(params.expectedPid));
        pushOptional(args, "--request", stringValue(params.request));
        pushOptional(args, "--fork-summary", stringValue(params.forkSummary));
        pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(config.storeDir));
        pushOptional(args, "--openclaw-session", openclawSession);
        pushOptional(args, "--gateway-url", stringValue(config.gatewayUrl));
        pushOptional(args, "--token", stringValue(config.gatewayToken));
        pushOptional(args, "--gateway-method", CALLBACK_METHOD);
        pushOptional(args, "--gateway-session", openclawSession);
        pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
        pushOptional(args, "--callback-command", stringValue(config.callbackCommand));
        pushOptional(args, "--soft-limit", numberString(config.softLimit));
        pushOptional(args, "--hard-limit", numberString(config.hardLimit));
        pushOptional(args, "--idle-timeout-minutes", numberString(config.idleTimeoutMinutes));
        pushOptional(args, "--codex-home", stringValue(params.codexHome) ?? stringValue(api.pluginConfig?.codexHome));
        pushOptional(args, "--max-messages", numberString(params.maxMessages));
        pushOptional(args, "--max-commands", numberString(params.maxCommands));
        pushOptional(args, "--max-text-length", numberString(params.maxTextLength));
        return args;
      }
    });
  }
});

async function handleAkkCommand(api, ctx) {
  try {
    const parsed = parseAkkCommand(ctx.args);
    if (parsed.action === "help") {
      return { text: akkUsageText() };
    }
    if (parsed.action === "delegate") {
      const result = runDelegate(api, {
        agent: parsed.agent,
        request: parsed.request
      }, {
        sessionKey: ctx.sessionKey
      });
      return { text: formatDelegateCommandResult(result) };
    }
    if (parsed.action === "list") {
      const result = runCli(api, ["list"]);
      return { text: formatListCommandResult(result) };
    }
    if (parsed.action === "status") {
      const result = runCli(api, ["status", "--conversation", parsed.conversationId]);
      return { text: formatStatusCommandResult(result) };
    }
    if (parsed.action === "send") {
      const args = [
        "send",
        "--conversation",
        parsed.conversationId,
        "--message",
        parsed.message,
        "--background"
      ];
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      pushOptional(args, "--all-proxy", stringValue(config.codexAllProxy) ?? stringValue(config.allProxy));
      pushOptional(args, "--model", stringValue(config.codexModel) ?? stringValue(config.model));
      pushOptional(args, "--idle-timeout-minutes", numberString(config.idleTimeoutMinutes));
      const result = runCli(api, args);
      return { text: formatSendCommandResult(result) };
    }
    if (parsed.action === "cancel") {
      const args = [
        "cancel",
        "--conversation",
        parsed.conversationId
      ];
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      pushOptional(args, "--all-proxy", stringValue(config.codexAllProxy) ?? stringValue(config.allProxy));
      pushOptional(args, "--idle-timeout-minutes", numberString(config.idleTimeoutMinutes));
      const result = runCli(api, args);
      return { text: formatCancelCommandResult(result) };
    }
    if (parsed.action === "recover" || parsed.action === "restart") {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = [
        parsed.action,
        "--conversation",
        parsed.conversationId,
        "--background"
      ];
      pushOptional(args, "--all-proxy", stringValue(config.codexAllProxy) ?? stringValue(config.allProxy));
      pushOptional(args, "--model", stringValue(config.codexModel) ?? stringValue(config.model));
      pushOptional(args, "--idle-timeout-minutes", numberString(config.idleTimeoutMinutes));
      const result = runCli(api, args);
      return { text: formatRecoveryCommandResult(result, parsed.action) };
    }
    if (parsed.action === "close") {
      const result = runCli(api, [
        "close",
        "--conversation",
        parsed.conversationId,
        "--reason",
        parsed.reason
      ]);
      return { text: formatCloseCommandResult(result) };
    }
    return { text: akkUsageText(), isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `AKK command failed: ${message}`,
      isError: true
    };
  }
}

function parseAkkCommand(args) {
  const input = String(args ?? "").trim();
  if (!input || input === "help" || input === "-h" || input === "--help") {
    return { action: "help" };
  }

  const { token, rest } = takeToken(input);
  const action = String(token).toLowerCase();
  if (action === "list" || action === "ls" || action === "tasks") {
    return { action: "list" };
  }
  if (action === "status" || action === "show") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk status <conversation-id>");
    return { action: "status", conversationId };
  }
  if (action === "send" || action === "reply") {
    const { token: conversationId, rest: message } = takeRequiredToken(rest, "Usage: /akk send <conversation-id> <message>");
    const body = message.trim();
    if (!body) {
      throw new Error("Usage: /akk send <conversation-id> <message>");
    }
    return { action: "send", conversationId, message: body };
  }
  if (action === "cancel" || action === "stop") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk cancel <conversation-id>");
    return { action: "cancel", conversationId };
  }
  if (action === "recover") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk recover <conversation-id>");
    return { action: "recover", conversationId };
  }
  if (action === "restart") {
    const { token: conversationId } = takeRequiredToken(rest, "Usage: /akk restart <conversation-id>");
    return { action: "restart", conversationId };
  }
  if (action === "close" || action === "done") {
    const { token: conversationId, rest: reason } = takeRequiredToken(rest, "Usage: /akk close <conversation-id> [reason]");
    return { action: "close", conversationId, reason: reason.trim() || "Closed from /akk command" };
  }
  const executorDefinition = executorDefinitionForAlias(action);
  if (executorDefinition) {
    const request = rest.trim();
    if (!request) {
      throw new Error(`Usage: /akk ${executorDefinition.kind} <task>`);
    }
    return { action: "delegate", agent: executorDefinition.kind, request };
  }
  return { action: "delegate", agent: "codex", request: input };
}

function takeRequiredToken(input, usage) {
  const parsed = takeToken(input);
  if (!parsed.token) {
    throw new Error(usage);
  }
  return parsed;
}

function takeToken(input) {
  const value = String(input ?? "").trimStart();
  const match = value.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { token: "", rest: "" };
  }
  return {
    token: match[1],
    rest: match[2] ?? ""
  };
}

function akkUsageText() {
  return [
    "AKK usage:",
    "/akk <task>",
    "/akk codex <task>",
    "/akk claude <task>",
    "/akk list",
    "/akk status <conversation-id>",
    "/akk send <conversation-id> <message>",
    "/akk cancel <conversation-id>",
    "/akk recover <conversation-id>",
    "/akk restart <conversation-id>",
    "/akk close <conversation-id> [reason]"
  ].join("\n");
}

function formatDelegateCommandResult(result) {
  const agent = executorDisplayName(result.agent);
  return [
    `AKK 已交给 ${agent}。`,
    `conversation: ${result.conversation_id ?? "unknown"}`,
    `session: ${result.session ?? "unknown"}`,
    `status: ${result.conversation_status ?? result.status ?? "unknown"}`,
    "结果会通过 OpenClaw 回调返回当前会话。"
  ].join("\n");
}

function executorDisplayName(kind) {
  try {
    return executorDefinitionForKind(String(kind ?? "codex")).displayName;
  } catch {
    return String(kind ?? "agent");
  }
}

function formatListCommandResult(result) {
  const tasks = Array.isArray(result.tasks) ? result.tasks : [];
  if (!tasks.length) {
    return "AKK 当前没有打开的会话。";
  }
  return [
    `AKK open sessions (${tasks.length}):`,
    ...tasks.slice(0, 20).map(formatTaskLine)
  ].join("\n");
}

function formatStatusCommandResult(result) {
  const summary = result.summary ?? result.conversation ?? {};
  const lines = [
    `AKK status: ${summary.conversation_id ?? "unknown"}`,
    `agent: ${summary.agent ?? summary.executor?.kind ?? "unknown"}`,
    `status: ${summary.status ?? "unknown"}`,
    `session: ${summary.session ?? summary.executor?.session ?? "unknown"}`
  ];
  if (summary.request) {
    lines.push(`request: ${truncateText(summary.request, 180)}`);
  }
  return lines.join("\n");
}

function formatSendCommandResult(result) {
  const conversation = result.conversation ?? {};
  return [
    "AKK follow-up sent.",
    `conversation: ${conversation.conversation_id ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`,
    `launched: ${result.launched === true ? "yes" : "no"}`
  ].join("\n");
}

function formatCancelCommandResult(result) {
  const conversation = result.conversation ?? {};
  return [
    "AKK cancel requested.",
    `conversation: ${conversation.conversation_id ?? "unknown"}`,
    `agent: ${result.executor?.kind ?? conversation.executor?.kind ?? "unknown"}`,
    `session: ${result.executor?.session ?? conversation.executor?.session ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`
  ].join("\n");
}

function formatRecoveryCommandResult(result, action) {
  const conversation = result.conversation ?? {};
  return [
    action === "recover" ? "AKK recovery started." : "AKK restart started.",
    `conversation: ${conversation.conversation_id ?? "unknown"}`,
    `agent: ${result.executor?.kind ?? conversation.executor?.kind ?? "unknown"}`,
    `session: ${result.executor?.session ?? conversation.executor?.session ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`
  ].join("\n");
}

function formatCloseCommandResult(result) {
  const conversation = result.conversation ?? {};
  return [
    "AKK session closed.",
    `conversation: ${conversation.conversation_id ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`
  ].join("\n");
}

function formatTaskLine(task) {
  return [
    task.conversation_id ?? "unknown",
    task.agent ?? task.executor?.kind ?? "agent",
    task.status ?? "unknown",
    truncateText(task.request ?? "", 90)
  ].filter(Boolean).join(" | ");
}

function runDelegate(api, params, toolContext) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const workspace = stringValue(params.workspace) ?? stringValue(config.workspace) ?? process.cwd();
  const rawRequest = requiredString(params.request, "request");
  const prefixedRequest = stringValue(params.agent) ? undefined : parseLeadingExecutorAlias(rawRequest);
  const request = prefixedRequest?.request ?? rawRequest;
  const agent = executorDefinitionForKind(
    stringValue(params.agent) ?? prefixedRequest?.kind ?? stringValue(config.defaultAgent) ?? "codex"
  ).kind;
  const executorDefinition = executorDefinitionForKind(agent);
  const agentSession =
    stringValue(params.session) ??
    firstStringForKeys(params, executorDefinition.sessionConfigKeys) ??
    firstStringForKeys(config, executorDefinition.sessionConfigKeys);
  const allProxy =
    stringValue(params.allProxy) ??
    firstStringForKeys(params, executorDefinition.proxyConfigKeys) ??
    firstStringForKeys(config, executorDefinition.proxyConfigKeys) ??
    stringValue(config.allProxy);
  const model =
    stringValue(params.model) ??
    firstStringForKeys(params, executorDefinition.modelConfigKeys) ??
    firstStringForKeys(config, executorDefinition.modelConfigKeys) ??
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
    request,
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
  pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
  pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(config.agentTimeoutMinutes));

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
    (toolContext) => ({
      name,
      description,
      parameters,
      async execute(_toolCallId, params) {
        const result = runCli(api, buildArgs(isRecord(params) ? params : {}, toolContext));
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

function buildRecoveryArgs(api, command, params) {
  const args = [command, "--conversation", requiredString(params.conversation_id, "conversation_id"), "--background"];
  pushOptional(args, "--session", stringValue(params.session));
  pushOptional(args, "--all-proxy", stringValue(params.allProxy) ?? stringValue(api.pluginConfig?.codexAllProxy) ?? stringValue(api.pluginConfig?.allProxy));
  pushOptional(args, "--model", stringValue(params.model) ?? stringValue(api.pluginConfig?.codexModel) ?? stringValue(api.pluginConfig?.model));
  pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(api.pluginConfig?.storeDir));
  pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
  return args;
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
    chat_send: delivery.chat_send,
    session_send: "session_send" in delivery ? delivery.session_send : undefined,
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
    mode: "chat.send",
    chat_send: {
      sessionKey,
      message: [
        "Continue this OpenClaw product-manager conversation from the Agent Knock Knock callback below.",
        "Treat the callback as a structured message from the delegated coding agent, not as a terminal log, status announcement, or instruction to inspect local state.",
        "Respond in this conversation as OpenClaw product manager. If the callback is question or blocked, make the product decision and answer the delegated coding agent. If it is done, summarize the result to the user.",
        "Do not poll files, processes, sessions, stdout, or stderr. Use only the structured callback payload below.",
        "",
        formatted
      ].join("\n"),
      idempotencyKey: `agent-knock-knock-callback:${conversationId ?? "unknown"}:${messageId ?? "unknown"}`,
      deliver: true
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
  const shortcuts = type === "done" ? formatDoneShortcuts(conversationId) : "";

  return [
    "[Agent Knock Knock callback]",
    `Conversation: ${conversationId}`,
    `Message type: ${type}`,
    `Requires OpenClaw response: ${requiresResponse}`,
    `Round: ${round}`,
    stateLine.trimEnd(),
    "",
    body,
    shortcuts
  ].filter((line) => line !== "").join("\n");
}

function formatDoneShortcuts(conversationId) {
  return [
    "",
    "[AKK convenience commands]",
    "When summarizing this result to the user, include these short next-step commands:",
    "- `AKK list` lists open AKK sessions.",
    `- \`AKK send ${conversationId}: <message>\` sends a follow-up to this same AKK session.`,
    `- \`AKK status ${conversationId}\` shows this session status.`,
    `- \`AKK cancel ${conversationId}\` requests cancellation of current running work without closing this AKK session.`,
    `- \`AKK close ${conversationId}\` closes this AKK session.`
  ].join("\n");
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

function firstStringForKeys(source, keys) {
  if (!isRecord(source)) {
    return undefined;
  }
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function numberString(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
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

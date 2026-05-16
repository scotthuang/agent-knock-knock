import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultBinPath = path.join(pluginRoot, "bin", "agent-knock-knock.js");

const delegateParameters = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  properties: {
    request: {
      type: "string",
      description: "Implementation task for Claude Code."
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

export default definePluginEntry({
  id: "agent-knock-knock",
  name: "Agent Knock Knock",
  description: "Controlled delegation from OpenClaw to Claude Code.",
  register(api) {
    api.registerTool(
      {
        name: "agent_knock_knock_delegate",
        description:
          "Delegate an implementation task to Claude Code. Use this when OpenClaw has decided the product requirements and wants an engineering agent to implement them. The tool starts Claude Code in the background and returns only protocol metadata, not Claude's raw terminal output.",
        parameters: delegateParameters,
        async execute(_toolCallId, params) {
          const result = runDelegate(api, params);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }
      },
      { optional: true }
    );
  }
});

function runDelegate(api, params) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const workspace = stringValue(params.workspace) ?? stringValue(config.workspace) ?? process.cwd();
  const args = [
    binPath,
    "delegate",
    "--request",
    requiredString(params.request, "request"),
    "--workspace",
    workspace,
    "--background"
  ];

  pushOptional(args, "--store-dir", stringValue(params.storeDir) ?? stringValue(config.storeDir));
  pushOptional(args, "--claude-session", stringValue(params.claudeSession) ?? stringValue(config.claudeSession));
  pushOptional(args, "--openclaw-session", stringValue(params.openclawSession) ?? stringValue(config.openclawSession));
  pushOptional(args, "--gateway-url", stringValue(config.gatewayUrl));
  pushOptional(args, "--token", stringValue(config.gatewayToken));
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
  return {
    status: "delegated",
    conversation_id: parsed.conversation?.conversation_id,
    conversation_status: parsed.conversation?.status,
    state_path: parsed.paths?.statePath,
    event_log_path: parsed.paths?.logPath,
    claude_session: parsed.conversation?.claude_session,
    launched: parsed.launched === true,
    background: parsed.background === true,
    pid: parsed.pid ?? null,
    note:
      "Claude Code was launched in the background. Only structured protocol callbacks should be used for follow-up messages."
  };
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

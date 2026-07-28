import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginDefinition
} from "openclaw/plugin-sdk/plugin-entry";
import {
  EXECUTOR_KINDS,
  executorDefinitionForKind,
  parseLeadingExecutorAlias
} from "./executors.js";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  parseAkkCommand,
  resolvePluginStoreDir
} from "./openclaw-plugin-helpers.js";
import {
  attemptAutoApproval
} from "./approval-policy.js";

const CALLBACK_METHOD = AKK_CALLBACK_METHOD;
const defaultBinPath = fileURLToPath(new URL("./cli.js", import.meta.url));

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
      description: "Workspace path for the selected coding agent. Defaults to plugin config or the Gateway process directory."
    },
    idleTimeoutMinutes: {
      type: "number",
      description: "Minutes an idle AKK session remains open before lazy cleanup closes it."
    },
    agentTimeoutMinutes: {
      type: "number",
      description: "Callback timeout in minutes; terminal bridge tasks treat it as an inactivity timeout."
    },
    agentHardTimeoutMinutes: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Maximum terminal monitor lifetime in minutes."
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
    managedOnly: {
      type: "boolean",
      description: "When true, only list AKK-managed delegated tasks and skip native/terminal active discovery."
    },
    noApprovalScan: {
      type: "boolean",
      description: "When true, list terminal-controlled sessions without scanning terminal panes for approval prompts."
    },
    terminalDebug: {
      type: "boolean",
      description: "When true, include tmux terminal discovery diagnostics for debugging Gateway environment issues."
    },
    idleTimeoutMinutes: {
      type: "number"
    }
  }
};

const renewParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string",
      description: "Stalled AKK-managed terminal bridge conversation id."
    },
    minutes: {
      type: "number",
      exclusiveMinimum: 0,
      description: "New terminal inactivity timeout in minutes."
    }
  }
};

const retryCallbackParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string",
      description: "AKK-managed conversation whose persisted callback delivery is pending or failed."
    }
  }
};

const statusParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string",
      description:
        "AKK-managed conversation id, or a terminal-controlled id from AKK list such as terminal:v2:tmux:codex:codex-work:0.1:33389."
    },
    idleTimeoutMinutes: {
      type: "number"
    },
    trace: {
      type: "boolean",
      description: "Include a safe executor trace summary with tool calls, permission requests, monitor events, and redacted thinking markers."
    }
  }
};

const describeParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string",
      description:
        "AKK-managed conversation id, native Codex id, or terminal-controlled id from AKK list. Use this when the user asks what a listed AKK/Codex session is about."
    },
    idleTimeoutMinutes: {
      type: "number"
    },
    maxMessages: {
      type: "number"
    },
    maxCommands: {
      type: "number"
    },
    maxTextLength: {
      type: "number"
    }
  }
};

const sendParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id", "message"],
  properties: {
    conversation_id: {
      type: "string",
      description:
        "AKK-managed conversation id, or a terminal-controlled id from AKK list such as terminal:v2:tmux:codex:codex-work:0.1:33389. When the user refers to a listed tmux target like my-work:0.1, resolve it to the terminal-controlled id from AKK list before sending."
    },
    message: {
      type: "string"
    },
    type: {
      type: "string",
      enum: ["answer", "task", "control", "error"]
    },
    idleTimeoutMinutes: {
      type: "number"
    },
    agentTimeoutMinutes: {
      type: "number",
      description: "Terminal bridge inactivity timeout override in minutes."
    },
    agentHardTimeoutMinutes: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Terminal bridge fallback lifetime ceiling override in minutes."
    }
  }
};

const cancelParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id"],
  properties: {
    conversation_id: {
      type: "string",
      description:
        "AKK-managed conversation id, or a terminal-controlled id from AKK list such as terminal:v2:tmux:codex:codex-work:0.1:33389."
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
    expected_message_id: {
      type: "string",
      description:
        "Required only to clear an orphaned terminal dispatch shown by AKK list. Must exactly match that entry's current message_id."
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
      enum: ["terminal_control"],
      description:
        "Attach to the existing Codex process through its shared tmux terminal."
    },
    createConversation: {
      type: "boolean",
      description:
        "When true and the selected strategy is ready, create an AKK-managed conversation bound to the native session so later AKK send/status/close can use it."
    },
    confirmTerminal: {
      type: "boolean",
      description:
        "Only for strategy=terminal_control. When true, AKK attaches to the exact terminalTarget after the user confirms that terminal pane."
    },
    terminalTarget: {
      type: "string",
      description:
        "Required with confirmTerminal=true. The exact tmux target from the previous terminal_control plan, such as codex-work:0.0."
    },
    request: {
      type: "string",
      description: "Optional user-visible request label stored on the created AKK conversation."
    },
    codexHome: {
      type: "string",
      description: "Optional Codex home directory. Defaults to ~/.codex."
    }
  }
};

const approveParameters = {
  type: "object",
  additionalProperties: false,
  required: ["conversation_id", "expected_approval_fingerprint"],
  properties: {
    conversation_id: {
      type: "string",
      description:
        "AKK-managed conversation id, or a terminal-controlled id from AKK list such as terminal:v2:tmux:codex:codex-work:0.1:33389."
    },
    expected_approval_fingerprint: {
      type: "string",
      description:
        "Exact approval fingerprint returned by the latest status or approval-required callback. The prompt is captured again and must still match before keys are sent."
    }
  }
};

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "agent-knock-knock",
  name: "Agent Knock Knock",
  description:
    "Agent Knock Knock (AKK/akk) lets OpenClaw operate local Codex and Claude Code through shared tmux terminals, with visible monitoring, approvals, callbacks, cancellation, and seamless human takeover.",
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

    try {
      api.registerService?.({
        id: "agent-knock-knock-monitor-reconciliation",
        start() {
          try {
            const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
            const args = ["reconcile-monitors"];
            pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
            const result = runCli(api, args);
            api.logger.info?.(
              "agent-knock-knock monitor reconciliation: " +
              `checked=${result.checked ?? 0} launched=${result.launched ?? 0} ` +
              `already_running=${result.already_running ?? 0} skipped=${result.skipped ?? 0} ` +
              `errors=${result.errors ?? 0}`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.warn?.(
              `agent-knock-knock monitor reconciliation skipped after startup error: ${message}`
            );
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn?.(
        `agent-knock-knock monitor reconciliation service was not registered: ${message}`
      );
    }

    api.registerCommand?.({
      name: "akk",
      description: "Delegate coding work to Agent Knock Knock, list tasks, send follow-ups, cancel running work, and close tasks.",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: {
        default: "AKK is handling the request..."
      },
      agentPromptGuidance: [
        "Use /akk <task> to send work through a uniquely matching idle tmux terminal. /akk uses the plugin-configured defaultAgent and falls back to Codex; use /akk claude <task> or /akk codex <task> when the user explicitly requests that agent."
      ],
      handler: async (ctx) => handleAkkCommand(api, ctx)
    });

    api.registerTool(
      (toolContext) => ({
        label: "AKK Delegate",
        name: "agent_knock_knock_delegate",
        description:
          "Send an implementation task to a uniquely matching idle Codex or Claude Code tmux terminal. AKK never starts a hidden coding-agent runtime; no match or an ambiguous match fails closed with setup guidance. Omit agent to use the configured default, falling back to Codex.",
        parameters: delegateParameters,
        async execute(_toolCallId, params) {
          const result = await runDelegate(api, params, toolContext);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ],
            details: result
          };
        }
      }),
      { name: "agent_knock_knock_delegate", optional: true }
    );

    registerCliTool(api, {
      name: "agent_knock_knock_list",
      description: "List Agent Knock Knock work and local active coding-agent sessions. Use this for AKK list, current AKK tasks, native Codex work, terminal-controlled Codex or Claude Code work, or asking which coding-agent sessions are open. The result separates delegated tasks, native processes, and terminal-controlled sessions; terminal entries include approval state when available.",
      parameters: listParameters,
      buildArgs: (params) => {
        const args = ["list"];
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(isRecord(api.pluginConfig) ? api.pluginConfig : {})
        );
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        pushOptional(args, "--agent", stringValue(params.agent));
        pushOptional(args, "--status", stringValue(params.status));
        if (params.all === true) {
          args.push("--all");
        }
        if (params.managedOnly === true) {
          args.push("--managed-only");
        }
        if (params.noApprovalScan === true) {
          args.push("--no-approval-scan");
        }
        if (params.terminalDebug === true) {
          args.push("--terminal-debug");
        }
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_status",
      description: "Get detailed status for one Agent Knock Knock coding-agent task or terminal-controlled session. For terminal-controlled ids from AKK list, this is the only read-result/screen-inspection command: AKK captures the terminal pane internally and returns terminal_screen.",
      parameters: statusParameters,
      buildArgs: (params) => {
        const args = ["status", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(isRecord(api.pluginConfig) ? api.pluginConfig : {})
        );
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        if (params.trace === true) {
          args.push("--trace");
        }
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_describe",
      description: "Describe what a listed Agent Knock Knock or local coding-agent session is about. It summarizes AKK history when available, otherwise uses supported durable agent context or a conservative terminal-screen fallback with confidence and limitations.",
      parameters: describeParameters,
      buildArgs: (params) => {
        const args = ["describe", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(isRecord(api.pluginConfig) ? api.pluginConfig : {})
        );
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        pushOptional(args, "--max-messages", numberString(params.maxMessages));
        pushOptional(args, "--max-commands", numberString(params.maxCommands));
        pushOptional(args, "--max-text-length", numberString(params.maxTextLength));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_send",
      description: "Send a message, follow-up, or new task to an existing open Agent Knock Knock or terminal-controlled coding-agent session from AKK list, including Codex or Claude Code in tmux. Do not start a new delegate for those requests. This is asynchronous: after acceptance, end the OpenClaw turn and wait for the AKK callback or a later explicit status request.",
      parameters: sendParameters,
      buildArgs: (params, toolContext) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const openclawSession =
          stringValue(toolContext?.sessionKey) ??
          "agent:main:main";
        const args = [
          "send",
          "--conversation",
          requiredString(params.conversation_id, "conversation_id"),
          "--message",
          requiredString(params.message, "message"),
          "--background"
        ];
        pushOptional(args, "--type", stringValue(params.type));
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
        pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(config.agentTimeoutMinutes));
        pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));
        pushOptional(args, "--openclaw-session", openclawSession);
        pushOptional(args, "--gateway-method", CALLBACK_METHOD);
        pushOptional(args, "--gateway-session", openclawSession);
        pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_approve",
      description:
        "Manually approve the current AKK terminal permission request only after the user reviews and explicitly confirms it. Claude Code uses no Hooks: this manual path accepts only an exact one-time Bash permission screen for the current managed turn, then recaptures its short-lived evidence and process identity before sending Enter. Separately, trusted default-disabled plugin configuration can auto-approve an exact Claude command/workspace match without exposing policy control to the model. Hook-free durable completion is independently verified from the local Claude transcript.",
      parameters: approveParameters,
      buildArgs: (params) => {
        const args = ["approve", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(
          args,
          "--expected-approval-fingerprint",
          requiredString(params.expected_approval_fingerprint, "expected_approval_fingerprint")
        );
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(isRecord(api.pluginConfig) ? api.pluginConfig : {})
        );
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_renew",
      description: "Renew monitoring for a stalled AKK-managed terminal bridge task without sending text or keys to the coding agent. Use this when the user wants a still-live long-running terminal task to keep monitoring after an inactivity stall.",
      parameters: renewParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["renew", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--minutes", numberString(params.minutes) ?? numberString(config.agentTimeoutMinutes));
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_retry_callback",
      description: "Retry a persisted AKK callback that failed before reaching OpenClaw. The original callback message id is reused for idempotent delivery; a completed terminal task remains available for follow-up until idle cleanup.",
      parameters: retryCallbackParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["retry-callback", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_cancel",
      description: "Interrupt an existing Agent Knock Knock Codex or Claude Code tmux task. Claude sends Escape; Codex uses its declared interrupt key. The shared tmux pane remains open for human takeover.",
      parameters: cancelParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["cancel", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_close",
      description:
        "Close an AKK-managed task record without terminating the shared tmux pane. For an orphaned terminal dispatch only, the user must explicitly request recovery and provide the exact expected_message_id reported by AKK list.",
      parameters: closeParameters,
      buildArgs: (params) => {
        const args = ["close", "--conversation", requiredString(params.conversation_id, "conversation_id")];
        pushOptional(args, "--reason", stringValue(params.reason));
        pushOptional(
          args,
          "--expected-message-id",
          stringValue(params.expected_message_id)
        );
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(isRecord(api.pluginConfig) ? api.pluginConfig : {})
        );
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_agent_takeover",
      description:
        "Build or execute a terminal-control attachment plan for an existing Codex session running inside tmux. The first call is side-effect-free; attach only after the user confirms the exact tmux target.",
      parameters: agentTakeoverParameters,
      buildArgs: (params, toolContext) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const openclawSession =
          stringValue(toolContext?.sessionKey) ??
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
        if (params.confirmTerminal === true) {
          args.push("--confirm-terminal");
        }
        pushOptional(args, "--terminal-target", stringValue(params.terminalTarget));
        pushOptional(args, "--request", stringValue(params.request));
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--openclaw-session", openclawSession);
        pushOptional(args, "--gateway-method", CALLBACK_METHOD);
        pushOptional(args, "--gateway-session", openclawSession);
        pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
        pushOptional(args, "--idle-timeout-minutes", numberString(config.idleTimeoutMinutes));
        pushOptional(args, "--codex-home", stringValue(params.codexHome) ?? stringValue(api.pluginConfig?.codexHome));
        return args;
      }
    });
  }
});

export default plugin;

async function handleAkkCommand(api, ctx) {
  try {
    const parsed = parseAkkCommand(ctx.args);
    if (parsed.action === "help") {
      return { text: akkUsageText() };
    }
    if (parsed.action === "delegate") {
      const result = await runDelegate(api, {
        agent: parsed.agent,
        request: parsed.request
      }, {
        sessionKey: ctx.sessionKey
      });
      return {
        text: formatDelegateCommandResult(result),
        isError: result.status !== "async_pending"
      };
    }
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = buildAkkCommandCliArgs(parsed, config, {
      sessionKey: ctx.sessionKey
    });
    if (!args) {
      return { text: akkUsageText(), isError: true };
    }
    // Doctor calls back into the running Gateway for its independent health
    // check. Keep the Gateway event loop free while that child CLI runs.
    const result = parsed.action === "doctor"
      ? await runCliAsync(api, args, { allowNonzeroJson: true })
      : runCli(api, args);
    switch (parsed.action) {
      case "doctor":
        return {
          text: formatDoctorCommandResult(result),
          isError: result.ok !== true
        };
      case "list":
        return { text: formatAkkListCommandResult(result) };
      case "status":
        return { text: formatStatusCommandResult(result) };
      case "describe":
        return { text: formatDescribeCommandResult(result) };
      case "send":
        return {
          text: formatSendCommandResult(result),
          isError: ["uncertain", "aborted"].includes(
            String(result.submission_outcome ?? "")
          )
        };
      case "approve":
        return { text: formatApproveCommandResult(result) };
      case "renew":
        return { text: formatRenewCommandResult(result) };
      case "retry-callback":
        return { text: formatRetryCallbackCommandResult(result) };
      case "cancel":
        return { text: formatCancelCommandResult(result) };
      case "close":
        return { text: formatCloseCommandResult(result) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `AKK command failed: ${message}`,
      isError: true
    };
  }
}

function formatDelegateCommandResult(result) {
  const agent = executorDisplayName(result.agent);
  if (result.status === "submission_uncertain") {
    return [
      `AKK could not prove whether ${agent} received the terminal task.`,
      `conversation: ${result.conversation_id ?? "unknown"}`,
      `session: ${result.session ?? "unknown"}`,
      "next: do not retry automatically; inspect AKK status and the named tmux pane."
    ].join("\n");
  }
  if (result.status === "submission_aborted") {
    return [
      `AKK stopped before sending the terminal task to ${agent}.`,
      `conversation: ${result.conversation_id ?? "unknown"}`,
      `session: ${result.session ?? "unknown"}`,
      "next: no tmux input was sent, so this request may be retried."
    ].join("\n");
  }
  return [
    `AKK delegated the task to ${agent}.`,
    `conversation: ${result.conversation_id ?? "unknown"}`,
    `session: ${result.session ?? "unknown"}`,
    `status: ${result.conversation_status ?? result.status ?? "unknown"}`,
    "The result will return to this OpenClaw session through the callback."
  ].join("\n");
}

function executorDisplayName(kind) {
  try {
    return executorDefinitionForKind(String(kind ?? "codex")).displayName;
  } catch {
    return String(kind ?? "agent");
  }
}

function formatStatusCommandResult(result) {
  const summary = result.summary ?? result.conversation ?? result ?? {};
  const terminalStatus = isRecord(result.terminal_status) ? result.terminal_status : {};
  const terminalControl = isRecord(result.terminal_control) ? result.terminal_control : {};
  const lines = [
    `AKK status: ${summary.conversation_id ?? result.conversation_id ?? "unknown"}`,
    `agent: ${summary.agent ?? summary.executor?.kind ?? terminalStatus.agent ?? "unknown"}`,
    `status: ${summary.status ?? terminalStatus.activity_state ?? "unknown"}`,
    `session: ${summary.session ?? summary.executor?.session ?? terminalControl.target ?? "unknown"}`
  ];
  if (summary.request) {
    lines.push(`request: ${truncateText(summary.request, 180)}`);
  }
  return lines.join("\n");
}

function formatDoctorCommandResult(result) {
  const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
  const tmux = isRecord(capabilities.tmux) ? capabilities.tmux : {};
  const openclaw = isRecord(result.openclaw) ? result.openclaw : {};
  const checks = Array.isArray(openclaw.checks) ? openclaw.checks : [];
  const failures = checks
    .filter((check) => isRecord(check) && check.ok !== true)
    .map((check) => String(check.name ?? "unknown"));
  const remediation = [...new Set(
    checks.flatMap((check) =>
      isRecord(check) && Array.isArray(check.remediation)
        ? check.remediation.filter(
            (command): command is string =>
              typeof command === "string" && command.trim().length > 0
          )
        : []
    )
  )].slice(0, 3);
  return [
    `AKK doctor: ${result.ok === true ? "ready" : "needs attention"}`,
    `tmux: ${tmux.status ?? "unknown"}`,
    `OpenClaw package: ${openclaw.package_ready === true ? "ready" : "not ready"}`,
    `Gateway: ${openclaw.gateway_ready === true ? "healthy" : "unavailable"}`,
    ...(failures.length > 0 ? [`check: ${failures.join(", ")}`] : []),
    ...remediation.map((command) => `next: ${command}`)
  ].join("\n");
}

function formatRenewCommandResult(result) {
  return [
    `AKK monitoring renewed: ${result.conversation?.conversation_id ?? "unknown"}`,
    `inactivity timeout: ${result.agent_timeout_minutes ?? "unknown"} minutes`,
    `hard lifetime: ${result.agent_hard_timeout_minutes ?? "unknown"} minutes`,
    "No message or key was sent to the coding agent."
  ].join("\n");
}

function formatRetryCallbackCommandResult(result) {
  return [
    `AKK callback delivered: ${result.conversation?.conversation_id ?? "unknown"}`,
    `status: ${result.conversation?.status ?? "unknown"}`,
    `attempts: ${result.conversation?.callback_delivery?.attempts ?? "unknown"}`
  ].join("\n");
}

function formatDescribeCommandResult(result) {
  const lines = [
    `AKK description: ${result.conversation_id ?? "unknown"}`,
    `source: ${result.source ?? "unknown"}`,
    `confidence: ${result.confidence ?? "unknown"}`
  ];
  if (result.about) {
    lines.push(`about: ${truncateText(result.about, 500)}`);
  }
  const limitations = Array.isArray(result.limitations) ? result.limitations.filter(Boolean) : [];
  if (limitations.length > 0) {
    lines.push(`limitations: ${limitations.slice(0, 3).join("; ")}`);
  }
  return lines.join("\n");
}

function formatSendCommandResult(result) {
  const conversation = result.conversation ?? {};
  const conversationId = conversation.conversation_id ?? result.conversation_id ?? "unknown";
  const status = conversation.status ?? result.status ?? "unknown";
  const nextAction = isRecord(result.openclaw_next_action) ? result.openclaw_next_action : undefined;
  if (result.submission_outcome === "uncertain") {
    return [
      "AKK terminal submission outcome is uncertain.",
      `conversation: ${conversationId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry automatically; inspect AKK status and the named tmux pane."
    ].join("\n");
  }
  if (result.submission_outcome === "aborted") {
    return [
      "AKK terminal submission was aborted before tmux input.",
      `conversation: ${conversationId}`,
      `status: ${result.status ?? status}`,
      "next: this request was not sent and may be retried."
    ].join("\n");
  }
  const lines = [
    "AKK follow-up sent.",
    `conversation: ${conversationId}`,
    `status: ${status}`
  ];
  if (result.source) {
    lines.push(`source: ${result.source}`);
  }
  return [
    ...lines,
    nextAction?.action === "yield"
      ? "next: yield now and wait for the AKK callback or an explicit status request."
      : `launched: ${result.launched === true ? "yes" : "no"}`
  ].join("\n");
}

function formatCancelCommandResult(result) {
  const conversation = result.conversation ?? {};
  const terminalControl = isRecord(result.terminal_control) ? result.terminal_control : {};
  return [
    "AKK cancel requested.",
    `conversation: ${conversation.conversation_id ?? result.conversation_id ?? "unknown"}`,
    `agent: ${result.executor?.kind ?? conversation.executor?.kind ?? "unknown"}`,
    `session: ${result.executor?.session ?? conversation.executor?.session ?? terminalControl.target ?? "unknown"}`,
    `status: ${conversation.status ?? (result.cancel_requested === true ? "cancel requested" : "not cancelled")}`
  ].join("\n");
}

function formatApproveCommandResult(result) {
  const conversation = result.conversation ?? {};
  return [
    result.approved === true
      ? "AKK approved the current terminal request."
      : "AKK did not approve the terminal request.",
    `conversation: ${conversation.conversation_id ?? result.conversation_id ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`,
    ...(result.reason ? [`reason: ${result.reason}`] : [])
  ].join("\n");
}

function formatCloseCommandResult(result) {
  if (
    result.source === "terminal_control" &&
    result.terminal_dispatch_resolved === true
  ) {
    const terminalControl = isRecord(result.terminal_control)
      ? result.terminal_control
      : {};
    return [
      "AKK cleared the unresolved terminal dispatch fence.",
      `terminal: ${terminalControl.target ?? "unknown"}`,
      `previous owner: ${result.owner_conversation_id ?? "unknown"}`,
      "The coding agent and tmux pane remain open."
    ].join("\n");
  }
  const conversation = result.conversation ?? {};
  return [
    "AKK session closed.",
    `conversation: ${conversation.conversation_id ?? "unknown"}`,
    `status: ${conversation.status ?? "unknown"}`
  ].join("\n");
}

async function runDelegate(api, params, toolContext) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const workspace = stringValue(params.workspace) ?? stringValue(config.workspace) ?? process.cwd();
  const rawRequest = requiredString(params.request, "request");
  const prefixedRequest = stringValue(params.agent) ? undefined : parseLeadingExecutorAlias(rawRequest);
  const request = prefixedRequest?.request ?? rawRequest;
  const agent = executorDefinitionForKind(
    stringValue(params.agent) ?? prefixedRequest?.kind ?? stringValue(config.defaultAgent) ?? "codex"
  ).kind;
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
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

  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
  pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(config.agentTimeoutMinutes));
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));

  const parsed = await runCliAsync(api, args.slice(1), { cwd: workspace });
  const conversationId =
    parsed.conversation?.conversation_id ??
    parsed.conversation_id;
  const statePath =
    parsed.conversation?.state_path ??
    parsed.paths?.statePath;
  const logPath =
    parsed.conversation?.event_log_path ??
    parsed.paths?.logPath;
  const submissionUncertain = parsed.submission_outcome === "uncertain";
  const submissionAborted = parsed.submission_outcome === "aborted";
  return {
    status: submissionUncertain
      ? "submission_uncertain"
      : submissionAborted
        ? "submission_aborted"
        : "async_pending",
    delegation_status: submissionUncertain
      ? "uncertain"
      : submissionAborted
        ? "aborted"
        : "delegated",
    conversation_id: conversationId,
    conversation_status: parsed.conversation?.status,
    state_path: statePath,
    event_log_path: logPath,
    agent,
    executor: parsed.conversation?.executor,
    session:
      parsed.conversation?.executor?.session ??
      parsed.terminal_control?.target,
    openclaw_session: openclawSession,
    launched: parsed.launched === true,
    replayed: parsed.replayed === true,
    background: parsed.background === true,
    pid: parsed.pid ?? parsed.terminal_control?.panePid ?? null,
    callback_method: CALLBACK_METHOD,
    ...(submissionUncertain
      ? {
          submission_outcome: "uncertain",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK could not prove whether tmux accepted Enter. Do not retry automatically; inspect the durable AKK conversation and shared terminal."
        }
      : submissionAborted
        ? {
            submission_outcome: "aborted",
            safe_to_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK stopped before sending tmux input. The request was not submitted and may be retried."
          }
      : {
          openclaw_next_action: {
            action: "yield",
            reason:
              "The coding agent is working in the shared tmux terminal. End this OpenClaw turn now and wait for an Agent Knock Knock callback.",
            do_not:
              "Do not poll terminal internals while waiting. Follow-up communication must use Agent Knock Knock tools so the same shared terminal remains authoritative.",
            expected_callback:
              "The callback will be injected and scheduled into this OpenClaw session by the agent-knock-knock.callback Gateway method."
          },
          note:
            "The task was sent to the shared tmux terminal. OpenClaw should yield now and wait for the scheduled callback turn."
        })
  };
}

function registerCliTool(api, { name, description, parameters, buildArgs }) {
  api.registerTool(
    (toolContext) => ({
      label: toolLabel(name),
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
          ],
          details: result
        };
      }
    }),
    { name, optional: true }
  );
}

function toolLabel(name) {
  const action = String(name)
    .replace(/^agent_knock_knock_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `AKK ${action || "Tool"}`;
}

function runCli(
  api,
  cliArgs,
  {
    cwd = process.cwd(),
    allowNonzeroJson = false
  }: {
    cwd?: string;
    allowNonzeroJson?: boolean;
  } = {}
) {
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
    if (allowNonzeroJson && spawned.stdout.trim()) {
      return parseJson(spawned.stdout);
    }
    throw new Error(cleanError(spawned.stderr || spawned.stdout || `agent-knock-knock ${cliArgs[0]} exited with status ${spawned.status}`));
  }

  return parseJson(spawned.stdout);
}

function runCliAsync(
  api,
  cliArgs,
  {
    cwd = process.cwd(),
    allowNonzeroJson = false,
    timeoutMs = 90_000
  }: {
    cwd?: string;
    allowNonzeroJson?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<Record<string, any>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const binPath = stringValue(config.binPath) ?? defaultBinPath;
  const maxBuffer = 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...cliArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `agent-knock-knock ${cliArgs[0]} failed to start: ${error.message}`
        )
      );
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(`agent-knock-knock ${cliArgs[0]} timed out`)
        );
        return;
      }
      if (overflow) {
        reject(
          new Error(`agent-knock-knock ${cliArgs[0]} output exceeded 10 MiB`)
        );
        return;
      }
      if (status !== 0) {
        if (allowNonzeroJson && stdout.trim()) {
          try {
            resolve(parseJson(stdout));
          } catch (error) {
            reject(error);
          }
          return;
        }
        reject(
          new Error(
            cleanError(
              stderr ||
                stdout ||
                `agent-knock-knock ${cliArgs[0]} exited with status ${status}`
            )
          )
        );
        return;
      }
      try {
        resolve(parseJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handleCallback(api, params) {
  if (!isRecord(params)) {
    throw new Error("callback params must be an object");
  }

  const message = isRecord(params.message) ? params.message : undefined;
  const conversation = isRecord(params.conversation) ? params.conversation : undefined;
  const messageMetadata = isRecord(message?.metadata) ? message.metadata : undefined;
  const sessionKey =
    stringValue(params.sessionKey) ??
    stringValue(conversation?.openclaw_session) ??
    stringValue(messageMetadata?.openclaw_session);

  if (!sessionKey) {
    throw new Error("callback params.sessionKey is required");
  }
  if (!message) {
    throw new Error("callback params.message is required");
  }

  const conversationId = stringValue(message.conversation_id) ?? stringValue(conversation?.conversation_id);
  const messageId = stringValue(message.id) ?? `${conversationId ?? "unknown"}:${stringValue(message.type) ?? "message"}:${Date.now()}`;
  const autoApproval = tryAutoApproveCallback({
    api,
    message,
    conversationId,
    statePath: stringValue(params.statePath)
  });
  if (autoApproval?.handled === true) {
    return {
      ok: true,
      enqueued: false,
      delivery_required: false,
      delivery_mode: "none",
      session_key: sessionKey,
      conversation_id: conversationId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      auto_approved: autoApproval.approved === true,
      approval_already_handled:
        autoApproval.action === "already_approved",
      approval: autoApproval
    };
  }
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

function tryAutoApproveCallback({ api, message, conversationId, statePath }) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const result = attemptAutoApproval({
    message,
    policy: config.autoApprove,
    statePath,
    execute: (args) => runCli(api, args)
  });
  if (result) {
    api.logger.info?.(
      `agent-knock-knock approval policy for ${conversationId ?? "unknown"}: ${result.action} (${result.reason})`
    );
  }
  return result;
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
    "- `AKK list` lists live shared terminals and open AKK tasks.",
    `- \`AKK send ${conversationId}: <message>\` continues in this same shared terminal.`,
    `- \`AKK status ${conversationId}\` shows this task record.`,
    `- \`AKK close ${conversationId}\` closes the AKK record without closing tmux.`
  ].join("\n");
}

function pushOptional(args, flag, value) {
  if (value !== undefined && value !== "") {
    args.push(flag, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
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

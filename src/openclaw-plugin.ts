import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  definePluginEntry,
  type OpenClawPluginDefinition
} from "openclaw/plugin-sdk/plugin-entry";
import {
  EXECUTOR_KINDS,
  executorDefinitionForKind
} from "./executors.js";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  formatAkkRespondCommandResult,
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  isAkkNativeSubmissionAccepted,
  isAkkThreadTransitionSuccess,
  parseAkkCommand,
  resolvePluginStoreDir
} from "./openclaw-plugin-helpers.js";
import {
  attemptAutoApproval
} from "./approval-policy.js";

const CALLBACK_METHOD = AKK_CALLBACK_METHOD;
const MONITOR_SUPERVISOR_INTERVAL_MS = 5_000;
const MAX_DISPLAYED_RESUME_SNAPSHOTS = 512;
const defaultBinPath = fileURLToPath(new URL("./cli.js", import.meta.url));
const relayPathByApi = new WeakMap<object, string>();

const sendParameters = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  not: { required: ["session_id", "selector"] },
  properties: {
    session_id: {
      type: "string",
      minLength: 1,
      description:
        "Authoritative AKK session id returned by list or a previous send. Ordinary sends target a session and create a new turn; discovery selectors, terminal ids, and turn ids are never session_id destinations."
    },
    selector: {
      type: "string",
      minLength: 1,
      description:
        "Compatibility/discovery selector: codex, claude, only, latest, an @short-ref, or a live terminal id. Use one only when explicitly named by the user or prefilled by list; never infer it. Prefer session_id once a session exists. Omit both fields only when AKK should attach the unique eligible idle pane."
    },
    request: {
      type: "string",
      minLength: 1,
      description:
        "Message for the coding agent. Each accepted ordinary send creates a new turn inside the selected session without clearing native agent context."
    },
    type: {
      type: "string",
      enum: ["task"],
      description:
        "Ordinary sends always create a task turn. Use agent_knock_knock_respond for an answer to an in-flight turn."
    },
    idleTimeoutMinutes: {
      type: "number",
      description:
        "Minutes an idle or completed AKK Turn record is retained before controlled reconciliation closes it."
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

const respondParameters = {
  type: "object",
  additionalProperties: false,
  required: ["turn_id", "request"],
  properties: {
    turn_id: {
      type: "string",
      description:
        "Authoritative AKK turn id from a question or blocked callback, never a discovery selector or terminal id. A response continues this exact in-flight turn and does not create a new turn."
    },
    request: {
      type: "string",
      description: "Answer or decision for the coding agent's exact in-flight turn."
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
    noApprovalScan: {
      type: "boolean",
      description: "When true, list live terminals without scanning their panes for approval prompts."
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

const listResumableThreadsParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the selected terminal row's current available_actions. Do not use a short ref, session id, turn id, or constructed selector."
    }
  }
};

const nativeInspectParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id", "inspection", "expected_binding_token"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the same current native_inspect action as expected_binding_token. Never use a short ref, Session id, Turn id, or constructed selector."
    },
    inspection: {
      type: "string",
      enum: ["status"],
      description:
        "Closed adapter-owned inspection kind. Initially only exact Codex /status is supported; this is never an arbitrary native command string."
    },
    expected_binding_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh snapshot-bound terminal and binding token prefilled by this terminal's current native_inspect action. Never guess, construct, or reuse it after another terminal action."
    }
  }
};

const newThreadParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id", "expected_binding_token"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the same current lifecycle snapshot as expected_binding_token."
    },
    expected_binding_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh compare-and-swap token prefilled by this terminal's available new_thread action or returned by agent_knock_knock_list_resumable_threads. Never guess, construct, or reuse it after another terminal action."
    }
  }
};

const reconcileBindingParameters = {
  type: "object",
  additionalProperties: false,
  required: [
    "terminal_id",
    "conflicting_session_id",
    "expected_session_revision",
    "expected_binding_token",
    "expected_terminal_token"
  ],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the same current reconcile_binding action as every expected token."
    },
    conflicting_session_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact conflicting managed Session id prefilled by AKK list. Never choose or construct one independently."
    },
    expected_session_revision: {
      type: "integer",
      minimum: 1,
      description:
        "Exact managed Session revision from the advertised reconcile_binding action."
    },
    expected_binding_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh fingerprint of the conflicting binding from the advertised action."
    },
    expected_terminal_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh fingerprint of the live terminal process incarnation from the same advertised action."
    }
  }
};

const resumeThreadParameters = {
  type: "object",
  additionalProperties: false,
  required: [
    "terminal_id",
    "native_thread_id",
    "expected_binding_token",
    "candidate_token"
  ],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id passed to agent_knock_knock_list_resumable_threads."
    },
    native_thread_id: {
      type: "string",
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      description:
        "Complete native thread UUID from a resumable=true row returned for this exact terminal. Never truncate, guess, or select an unavailable row."
    },
    expected_binding_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh compare-and-swap token from the same agent_knock_knock_list_resumable_threads result as native_thread_id."
    },
    candidate_token: {
      type: "string",
      minLength: 1,
      description:
        "Opaque fingerprint from the selected resumable thread row in the same current list result. It binds resume to that exact historical file/evidence snapshot; never construct or reuse it."
    }
  }
};

const renewParameters = {
  type: "object",
  additionalProperties: false,
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id whose monitoring should be renewed."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description: "Deprecated compatibility alias for turn_id."
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
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id whose persisted callback should be retried."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description: "Deprecated compatibility alias for turn_id."
    }
  }
};

const statusParameters = {
  type: "object",
  additionalProperties: false,
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id to inspect."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description:
        "Deprecated legacy Turn alias, or the exact raw-terminal selector prefilled by that terminal row's available status action. Managed Turn status must use turn_id; never construct or guess a raw-terminal selector."
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

const cancelParameters = {
  type: "object",
  additionalProperties: false,
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id to interrupt."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description:
        "Deprecated legacy Turn alias, or the exact raw-terminal selector prefilled by that terminal row's available cancel action. Managed Turn cancellation must use turn_id; never construct or guess a raw-terminal selector."
    },
    idleTimeoutMinutes: {
      type: "number"
    }
  }
};

const closeParameters = {
  type: "object",
  additionalProperties: false,
  not: {
    anyOf: [
      { required: ["turn_id", "conversation_id"] },
      { required: ["expected_message_id", "expected_transition_id"] }
    ]
  },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id whose managed record should be closed."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description:
        "Deprecated legacy Turn alias, or an exact list-prefilled raw-terminal/orphan recovery selector. Managed Turn close must use turn_id; never construct or guess a raw-terminal selector."
    },
    reason: {
      type: "string"
    },
    expected_message_id: {
      type: "string",
      description:
        "Required only to clear an orphaned terminal dispatch shown by AKK list. Must exactly match that entry's current message_id and must not be combined with expected_transition_id."
    },
    expected_transition_id: {
      type: "string",
      description:
        "Required only to recover an unresolved native-thread lifecycle transition shown by AKK list. Must exactly match that entry's current transition_id and must not be combined with expected_message_id."
    }
  }
};

const approveParameters = {
  type: "object",
  additionalProperties: false,
  required: ["expected_approval_fingerprint"],
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id containing the approval prompt."
    },
    conversation_id: {
      type: "string",
      deprecated: true,
      description:
        "Deprecated legacy Turn alias, or the exact raw-terminal selector prefilled by that terminal row's available approval action. Managed Turn approval must use turn_id; never construct or guess a raw-terminal selector."
    },
    expected_approval_fingerprint: {
      type: "string",
      description:
        "Exact approval fingerprint returned by the latest status or approval-required callback. The prompt is captured again and must still match before keys are sent."
    }
  }
};

function createPlugin(
  relayPath: string,
  {
    monitorSupervisorIntervalMs = MONITOR_SUPERVISOR_INTERVAL_MS
  }: {
    monitorSupervisorIntervalMs?: number;
  } = {}
): OpenClawPluginDefinition {
  const displayedResumeSnapshots = new Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >();
  return definePluginEntry({
  id: "agent-knock-knock",
  name: "Agent Knock Knock",
  description:
    "Agent Knock Knock (AKK/akk) lets OpenClaw operate local Codex and Claude Code through shared tmux terminals, with visible monitoring, approvals, callbacks, cancellation, and seamless human takeover.",
  register(api) {
    relayPathByApi.set(api, relayPath);
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
      api.registerService?.(
        createMonitorReconciliationService(
          api,
          monitorSupervisorIntervalMs
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn?.(
        `agent-knock-knock monitor reconciliation service was not registered: ${message}`
      );
    }

    api.registerCommand?.({
      name: "akk",
      description: "Send coding work through existing Codex or Claude Code tmux terminals, inspect managed turns, and explicitly start, clear, list, or resume native threads.",
      acceptsArgs: true,
      requireAuth: true,
      nativeProgressMessages: {
        default: "AKK is handling the request..."
      },
      agentPromptGuidance: [
        "Use /akk <task> when exactly one eligible idle coding-agent tmux pane should receive new work. Use /akk codex: <task>, /akk claude: <task>, or another selector returned by /akk list to target an existing pane. Ordinary sends preserve native context. Use /akk threads, /akk new-thread or clear-thread, and /akk resume-thread only with an exact full terminal_id returned by /akk list; these switch native context without creating a Turn. Resume numbers and short IDs are bound to the last displayed snapshot, while previous is available only from the latest verified committed transition. For native Codex status, use only an advertised agent_knock_knock_native_inspect action; agent_knock_knock_status inspects AKK Turn state and does not execute /status. AKK never starts a coding-agent process."
      ],
      handler: async (ctx) => handleAkkCommand(
        api,
        ctx,
        displayedResumeSnapshots
      )
    });

    registerCliTool(api, {
      name: "agent_knock_knock_list",
      description: "List existing Codex and Claude Code tmux panes as the primary terminals[] resources. Each terminal may include managed.current_turn or managed.recent_turn; all=true also includes older managed.history and retained unavailable history. By default, unavailable_managed_turns contains attention-needed records whose pane is unavailable. Use only each row's available_actions and authoritative prefilled arguments: send targets a session and starts a new turn; respond targets the exact in-flight turn; native_inspect currently runs only a closed, version-scoped Codex inspection with the current terminal/binding token; read-only thread listing targets the exact terminal, while new/resume mutations also require the current binding token and create no Turn; reconcile_binding detaches only the exact listed conflict and requires explicit user intent; managed controls target the exact turn; a raw terminal row may prefill its own compatibility selector for status or recovery controls. Never construct identifiers or tokens. AKK revalidates every terminal side effect and never starts a coding-agent process.",
      parameters: listParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["list", "--reconcile"];
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(config)
        );
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
        pushOptional(args, "--agent", stringValue(params.agent));
        pushOptional(args, "--status", stringValue(params.status));
        if (params.all === true) {
          args.push("--all");
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
      name: "agent_knock_knock_list_resumable_threads",
      description:
        "List verified native Codex or Claude Code threads for one exact terminal. Call this only from that terminal row's available list_resumable_threads action. The result includes the current native identity, a fresh expected_binding_token, exact candidate UUIDs with opaque candidate_token fingerprints, and an exact previous action only when the latest committed transition has one uniquely resumable source. Resume only a row with resumable=true or that previous action, preserving all full prefilled arguments from the same result. Number/short/handle fields are human display aids, never exact tool arguments. This is read-only for Session/Turn state and creates no AKK Turn.",
      parameters: listResumableThreadsParameters,
      normalizeTurnIdentity: false,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = [
          "list-resumable-threads",
          "--terminal",
          requiredString(params.terminal_id, "terminal_id")
        ];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--codex-home", stringValue(config.codexHome));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_native_inspect",
      description:
        "Execute one closed, version-scoped Codex native inspection in an exact terminal without ordinary Turn delivery. Call only from that terminal row's current native_inspect action and preserve its exact terminal_id, inspection=status, and expected_binding_token. Initial support is Codex-only and limited to verified Codex 0.146.0/0.146.1 /status; arbitrary slash commands, Claude commands, /usage, /model, and /compact remain unavailable. Bare Codex /usage opens an interactive menu whose later Enter can select an account-side usage-limit reset. This creates no AKK Session, Turn, receipt, monitor, or callback. agent_knock_knock_status is different: it inspects AKK Turn state and the bounded current screen without executing native /status.",
      parameters: nativeInspectParameters,
      normalizeTurnIdentity: false,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const inspection = requiredString(params.inspection, "inspection");
        if (inspection !== "status") {
          throw new Error("inspection must be status");
        }
        const args = [
          "native-inspect",
          "--terminal",
          requiredString(params.terminal_id, "terminal_id"),
          "--inspection",
          inspection,
          "--expected-binding-token",
          requiredString(
            params.expected_binding_token,
            "expected_binding_token"
          )
        ];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--codex-home", stringValue(config.codexHome));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_new_thread",
      description:
        "Start and verify a clean native coding-agent thread in the same exact tmux terminal. Call only from a current available new_thread action, using its exact terminal_id and expected_binding_token, or immediately after agent_knock_knock_list_resumable_threads using that result's token. Never send /clear as ordinary task text. This lifecycle transition creates a new AKK Session but no Turn; use ordinary send afterward.",
      parameters: newThreadParameters,
      normalizeTurnIdentity: false,
      isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = [
          "new-thread",
          "--terminal",
          requiredString(params.terminal_id, "terminal_id"),
          "--expected-binding-token",
          requiredString(
            params.expected_binding_token,
            "expected_binding_token"
          )
        ];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--codex-home", stringValue(config.codexHome));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_reconcile_binding",
      description:
        "Detach one exact conflicting managed Session binding without adopting the live replacement thread. Call only after the user explicitly requests recovery and only from a current terminal row's advertised reconcile_binding action. Preserve its terminal_id, conflicting_session_id, Session revision, binding token, and terminal token exactly. This action sends no coding-agent input and creates no Turn; refresh AKK list afterward.",
      parameters: reconcileBindingParameters,
      normalizeTurnIdentity: false,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const revision = Number(params.expected_session_revision);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new Error(
            "expected_session_revision must be a positive safe integer"
          );
        }
        const args = [
          "reconcile-binding",
          "--terminal",
          requiredString(params.terminal_id, "terminal_id"),
          "--conflicting-session",
          requiredString(
            params.conflicting_session_id,
            "conflicting_session_id"
          ),
          "--expected-session-revision",
          String(revision),
          "--expected-binding-token",
          requiredString(
            params.expected_binding_token,
            "expected_binding_token"
          ),
          "--expected-terminal-token",
          requiredString(
            params.expected_terminal_token,
            "expected_terminal_token"
          )
        ];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--codex-home", stringValue(config.codexHome));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_resume_thread",
      description:
        "Resume one exact verified historical native thread in the same tmux terminal. First call agent_knock_knock_list_resumable_threads, then pass its exact terminal_id and expected_binding_token plus one complete native_thread_id whose row says resumable=true and that same row's candidate_token. Never guess, truncate, or reuse IDs or tokens, and never send a resume slash command as ordinary task text. This creates or reactivates an AKK Session but creates no Turn.",
      parameters: resumeThreadParameters,
      normalizeTurnIdentity: false,
      isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = [
          "resume-thread",
          "--terminal",
          requiredString(params.terminal_id, "terminal_id"),
          "--native-thread",
          requiredString(params.native_thread_id, "native_thread_id"),
          "--expected-binding-token",
          requiredString(
            params.expected_binding_token,
            "expected_binding_token"
          ),
          "--candidate-token",
          requiredString(
            params.candidate_token,
            "candidate_token"
          )
        ];
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--codex-home", stringValue(config.codexHome));
        return args;
      }
    });

    api.registerTool(
      (_toolContext) => ({
        label: "AKK Status",
        name: "agent_knock_knock_status",
        description:
          "Inspect one exact AKK-managed turn by its authoritative turn_id, or use only a raw terminal row's own prefilled compatibility selector. The deprecated conversation_id remains a legacy Turn alias and the list-prefilled raw-terminal input; never construct it. Returns live state, a bounded terminal screen, and available purpose/context with confidence and limitations. AKK never starts a coding agent.",
        parameters: statusParameters,
        async execute(_toolCallId, params) {
          const result = runCli(
            api,
            buildStatusCliArgs(api, isRecord(params) ? params : {})
          );
          return toolResult(result);
        }
      }),
      { name: "agent_knock_knock_status", optional: true }
    );

    api.registerTool(
      (toolContext) => ({
        label: "AKK Send",
      name: "agent_knock_knock_send",
      description:
          "Start a new turn in an existing AKK session without clearing the coding agent's native context. Target the exact session_id from list or a prior send; never pass a turn id or discovery selector as session_id. selector is compatibility-only for initial live-terminal discovery: use one explicitly named by the user or prefilled by list, and never infer one. Both fields may be omitted only when AKK should require one unique eligible idle pane. To answer an in-flight question, use agent_knock_knock_respond instead. For ordinary use add only request and omit monitoring timeouts unless the user explicitly asks to change them. timeoutSeconds is unsupported. AKK never starts a coding agent. This is asynchronous: after acceptance, yield and wait for the callback or a later explicit status request.",
        parameters: sendParameters,
        async execute(toolCallId, params) {
          const result = await runSendRequest(
            api,
            isRecord(params) ? params : {},
            toolContext,
            terminalMessageIdForToolCall({
              toolCallId,
              sessionKey: toolContext?.sessionKey,
              sessionId: toolContext?.sessionId,
              toolName: "agent_knock_knock_send"
            })
          );
          return toolResult(result, { submissionErrors: true });
        }
      }),
      { name: "agent_knock_knock_send", optional: true }
    );

    registerCliTool(api, {
      name: "agent_knock_knock_respond",
      description:
        "Respond to a question or blocked callback in one exact in-flight AKK turn. This continues that turn and does not create a new turn; use agent_knock_knock_send with session_id for later ordinary work.",
      parameters: respondParameters,
      buildArgs: (params, toolContext, toolCallId) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const openclawSession =
          stringValue(toolContext?.sessionKey) ?? "agent:main:main";
        const args = [
          "respond",
          "--turn",
          authoritativeManagedId(params.turn_id, "turn_id"),
          "--message",
          requiredString(params.request, "request")
        ];
        pushOptional(
          args,
          "--message-id",
          terminalMessageIdForToolCall({
            toolCallId,
            sessionKey: openclawSession,
            sessionId: toolContext?.sessionId,
            toolName: "agent_knock_knock_respond"
          })
        );
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--openclaw-session", openclawSession);
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_approve",
      description:
        "Manually approve a permission request only after the user reviews and explicitly confirms it. Managed approval uses exact turn_id; an unmanaged raw terminal may be approved only through its own list-prefilled action. Claude Code uses no Hooks: this manual path accepts only an exact one-time Bash permission screen, then recaptures its short-lived evidence and process identity before sending Enter. Separately, trusted default-disabled plugin configuration can auto-approve an exact Claude command/workspace match without exposing policy control to the model. Hook-free durable completion is independently verified from the local Claude transcript.",
      parameters: approveParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["approve"];
        pushTurnTarget(args, params);
        pushOptional(
          args,
          "--expected-approval-fingerprint",
          requiredString(params.expected_approval_fingerprint, "expected_approval_fingerprint")
        );
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(config)
        );
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_renew",
      description: "Renew monitoring for one exact stalled turn_id without sending text or keys to the coding agent. Use this when the user wants a still-live long-running terminal task to keep monitoring after an inactivity stall.",
      parameters: renewParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["renew"];
        pushTurnTarget(args, params);
        pushOptional(args, "--minutes", numberString(params.minutes) ?? numberString(config.agentTimeoutMinutes));
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_retry_callback",
      description: "Retry a persisted AKK callback for an exact turn that failed before reaching OpenClaw. The original callback message id and turn identity are reused for idempotent delivery.",
      parameters: retryCallbackParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["retry-callback"];
        pushTurnTarget(args, params);
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_cancel",
      description: "Interrupt one exact AKK turn_id, or use only an unmanaged raw terminal row's own prefilled cancel action. Claude sends Escape; Codex uses its declared interrupt key. The shared tmux pane remains open for human takeover.",
      parameters: cancelParameters,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["cancel"];
        pushTurnTarget(args, params);
        pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
        pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
        return args;
      }
    });

    registerCliTool(api, {
      name: "agent_knock_knock_close",
      description:
        "Close an AKK-managed turn record without terminating the shared tmux pane. For a list-prefilled raw-terminal recovery, the user must explicitly request it and provide the exact expected_message_id or expected_transition_id reported by that AKK list entry.",
      parameters: closeParameters,
      isErrorResult: isBlockedTerminalDispatchResult,
      buildArgs: (params) => {
        const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
        const args = ["close"];
        assertExclusiveRecoveryFence(params);
        pushTurnTarget(args, params);
        pushOptional(args, "--reason", stringValue(params.reason));
        pushOptional(
          args,
          "--expected-message-id",
          stringValue(params.expected_message_id)
        );
        pushOptional(
          args,
          "--expected-transition-id",
          stringValue(params.expected_transition_id)
        );
        pushOptional(
          args,
          "--store-dir",
          resolvePluginStoreDir(config)
        );
        return args;
      }
    });

  }
  });
}

function createMonitorReconciliationService(
  api,
  configuredIntervalMs: number
) {
  const intervalMs = Number.isFinite(configuredIntervalMs) &&
    configuredIntervalMs > 0
    ? Math.max(50, Math.ceil(configuredIntervalMs))
    : MONITOR_SUPERVISOR_INTERVAL_MS;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const reconciliationArgs = (reason: string): string[] => {
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["reconcile-monitors", "--reason", reason];
    if (reason === "monitor_supervision") {
      args.push("--terminal-monitors-only");
    }
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    return args;
  };
  const report = (result: Record<string, any>, reason: string): void => {
    if (
      reason === "startup_reconciliation" ||
      Number(result.launched ?? 0) > 0 ||
      Number(result.errors ?? 0) > 0
    ) {
      const label = reason === "startup_reconciliation"
        ? "monitor reconciliation"
        : `monitor ${reason}`;
      api.logger.info?.(
        `agent-knock-knock ${label}: ` +
        `checked=${result.checked ?? 0} launched=${result.launched ?? 0} ` +
        `already_running=${result.already_running ?? 0} skipped=${result.skipped ?? 0} ` +
        `errors=${result.errors ?? 0}`
      );
    }
  };
  const schedule = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = supervise().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, intervalMs);
    timer.unref?.();
  };
  const supervise = async (): Promise<void> => {
    try {
      const result = await runCliAsync(
        api,
        reconciliationArgs("monitor_supervision")
      );
      report(result, "monitor_supervision");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn?.(
        `agent-knock-knock monitor supervision deferred after error: ${message}`
      );
    }
  };

  return {
    id: "agent-knock-knock-monitor-reconciliation",
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      try {
        const result = runCli(
          api,
          reconciliationArgs("startup_reconciliation")
        );
        report(result, "startup_reconciliation");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(
          `agent-knock-knock monitor reconciliation skipped after startup error: ${message}`
        );
      }
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    }
  };
}

const plugin: OpenClawPluginDefinition = createPlugin(defaultBinPath);

export function createOpenClawPluginForTest(
  relayPath: string,
  options: { monitorSupervisorIntervalMs?: number } = {}
): OpenClawPluginDefinition {
  return createPlugin(relayPath, options);
}

export default plugin;

function resumeSelectionScope(
  sessionKey: unknown,
  sessionId: unknown
): string {
  const key = requiredString(
    sessionKey,
    "OpenClaw session identity is required for snapshot-bound Resume"
  );
  const incarnation = stringValue(sessionId) ?? null;
  return `openclaw:${createHash("sha256")
    .update(JSON.stringify([key, incarnation]))
    .digest("hex")}`;
}

function resumeSnapshotCacheKey(
  sessionKey: unknown,
  sessionId: unknown,
  terminalId: string
): string {
  const key = requiredString(
    sessionKey,
    "OpenClaw session identity is required for snapshot-bound Resume"
  );
  return JSON.stringify([key, stringValue(sessionId) ?? null, terminalId]);
}

function rememberDisplayedResumeSnapshot(
  snapshots: Map<string, { snapshotId: string; expiresAtMs: number }>,
  key: string,
  snapshotId: string,
  expiresAtMs: number
): void {
  const now = Date.now();
  for (const [candidateKey, value] of snapshots) {
    if (value.expiresAtMs <= now) {
      snapshots.delete(candidateKey);
    }
  }
  snapshots.delete(key);
  while (snapshots.size >= MAX_DISPLAYED_RESUME_SNAPSHOTS) {
    const oldestKey = snapshots.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    snapshots.delete(oldestKey);
  }
  snapshots.set(key, { snapshotId, expiresAtMs });
}

function currentDisplayedResumeSnapshotId(
  snapshots: Map<string, { snapshotId: string; expiresAtMs: number }>,
  key: string
): string | undefined {
  const value = snapshots.get(key);
  if (!value) {
    return undefined;
  }
  if (value.expiresAtMs <= Date.now()) {
    snapshots.delete(key);
    return undefined;
  }
  return value.snapshotId;
}

async function handleAkkCommand(
  api,
  ctx,
  displayedResumeSnapshots: Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >
) {
  try {
    const parsed = parseAkkCommand(ctx.args);
    if (parsed.action === "help") {
      return { text: akkUsageText() };
    }
    if (parsed.action === "delegate") {
      const result = await runDelegate(api, {
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
    if (
      parsed.action === "list-resumable-threads" ||
      parsed.action === "new-thread" ||
      parsed.action === "resume-thread"
    ) {
      const selectionScope = resumeSelectionScope(
        ctx.sessionKey,
        ctx.sessionId
      );
      const snapshotCacheKey = resumeSnapshotCacheKey(
        ctx.sessionKey,
        ctx.sessionId,
        parsed.terminalId
      );
      if (
        parsed.action === "resume-thread" &&
        parsed.selection &&
        ["number", "short-id", "snapshot-handle"].includes(
          parsed.selection.kind
        )
      ) {
        const mutationArgs = buildAkkCommandCliArgs(parsed, config, {
          sessionKey: ctx.sessionKey,
          selectionScope,
          selectionSnapshotId:
            parsed.selection.kind === "snapshot-handle"
              ? undefined
              : currentDisplayedResumeSnapshotId(
                  displayedResumeSnapshots,
                  snapshotCacheKey
                )
        });
        if (!mutationArgs) {
          throw new Error("could not build snapshot-bound resume command");
        }
        const transitionResult = runCli(api, mutationArgs);
        if (isAkkThreadTransitionSuccess(transitionResult)) {
          displayedResumeSnapshots.delete(snapshotCacheKey);
        }
        return {
          text: formatAkkThreadTransitionCommandResult(transitionResult),
          isError: !isAkkThreadTransitionSuccess(transitionResult)
        };
      }
      const discoveryArgs = buildAkkCommandCliArgs(
        {
          action: "list-resumable-threads",
          terminalId: parsed.terminalId
        },
        config,
        { selectionScope }
      );
      if (!discoveryArgs) {
        throw new Error("could not build native-thread discovery command");
      }
      const discovery = runCli(api, discoveryArgs);
      if (
        parsed.action === "list-resumable-threads" ||
        (
          parsed.action === "resume-thread" &&
          !parsed.selection
        )
      ) {
        const snapshotId = isRecord(discovery.selection_snapshot)
          ? stringValue(discovery.selection_snapshot.snapshot_id)
          : undefined;
        const expiresAt = isRecord(discovery.selection_snapshot)
          ? Date.parse(String(discovery.selection_snapshot.expires_at ?? ""))
          : Number.NaN;
        if (snapshotId && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          rememberDisplayedResumeSnapshot(
            displayedResumeSnapshots,
            snapshotCacheKey,
            snapshotId,
            expiresAt
          );
        } else {
          displayedResumeSnapshots.delete(snapshotCacheKey);
        }
        return { text: formatAkkThreadsCommandResult(discovery) };
      }
      let expectedBindingToken = requiredString(
        discovery.expected_binding_token,
        "expected_binding_token from lifecycle discovery"
      );
      let candidateToken: string | undefined;
      let mutationCommand = parsed;
      if (parsed.action === "resume-thread") {
        let nativeThreadId: string;
        if (parsed.selection?.kind === "previous") {
          const previous = isRecord(discovery.previous)
            ? discovery.previous
            : undefined;
          const action = isRecord(previous?.available_actions) &&
              isRecord(previous.available_actions.resume_thread)
            ? previous.available_actions.resume_thread
            : undefined;
          const actionArguments = isRecord(action?.arguments)
            ? action.arguments
            : undefined;
          nativeThreadId = requiredString(
            actionArguments?.native_thread_id,
            "no verified previous native thread is available; run /akk threads"
          );
          if (stringValue(actionArguments?.terminal_id) !== parsed.terminalId) {
            throw new Error("previous resume action belongs to another terminal");
          }
          expectedBindingToken = requiredString(
            actionArguments?.expected_binding_token,
            "expected_binding_token from the previous resume action"
          );
          candidateToken = requiredString(
            actionArguments?.candidate_token,
            "candidate_token from the previous resume action"
          );
        } else {
          if (parsed.selection?.kind !== "exact") {
            throw new Error("resume selection could not be resolved");
          }
          nativeThreadId = parsed.selection.nativeThreadId;
          const candidate = Array.isArray(discovery.threads)
            ? discovery.threads.find((thread) =>
                isRecord(thread) &&
                stringValue(thread.native_thread_id) === nativeThreadId
              )
            : undefined;
          if (!isRecord(candidate) || candidate.resumable !== true) {
            throw new Error(
              `native thread ${nativeThreadId} is not resumable in the current lifecycle snapshot`
            );
          }
          candidateToken = requiredString(
            candidate.candidate_token,
            "candidate_token from the selected resumable thread"
          );
        }
        mutationCommand = {
          action: "resume-thread",
          terminalId: parsed.terminalId,
          selection: { kind: "exact", nativeThreadId }
        };
      }
      const mutationArgs = buildAkkCommandCliArgs(mutationCommand, config, {
        sessionKey: ctx.sessionKey,
        expectedBindingToken,
        candidateToken,
        selectionScope
      });
      if (!mutationArgs) {
        throw new Error("could not build native-thread lifecycle command");
      }
      const transitionResult = runCli(api, mutationArgs);
      if (isAkkThreadTransitionSuccess(transitionResult)) {
        displayedResumeSnapshots.delete(snapshotCacheKey);
      }
      return {
        text: formatAkkThreadTransitionCommandResult(transitionResult),
        isError: !isAkkThreadTransitionSuccess(transitionResult)
      };
    }
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
      case "send":
        return {
          text: formatSendCommandResult(result),
          isError: terminalSubmissionReported(result)
            ? !isAkkNativeSubmissionAccepted(result)
            : result.status === "delivered_unfenced"
        };
      case "respond":
        return formatAkkRespondCommandResult(result);
      case "approve":
        return { text: formatApproveCommandResult(result) };
      case "renew":
        return { text: formatRenewCommandResult(result) };
      case "retry-callback":
        return { text: formatRetryCallbackCommandResult(result) };
      case "cancel":
        return { text: formatCancelCommandResult(result) };
      case "close":
        return {
          text: formatCloseCommandResult(result),
          isError: isBlockedTerminalDispatchResult(result)
        };
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
  const { sessionId, turnId } = publicTurnIdentity(result);
  if (result.status === "submission_unfenced") {
    return [
      `AKK sent the terminal input to ${agent}, but could not bind later side effects to an exact native session.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry or continue automatically; inspect the named pane and close this Turn before sending more work."
    ].join("\n");
  }
  if (result.status === "submission_uncertain") {
    return [
      `AKK could not prove whether ${agent} received the terminal task.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry automatically; inspect AKK status and the named tmux pane."
    ].join("\n");
  }
  if (result.status === "submission_aborted") {
    const safeToRetry =
      result.safe_to_retry === true && result.do_not_retry !== true;
    return [
      `AKK stopped before sending the terminal task to ${agent}.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      safeToRetry
        ? "next: no tmux input was sent and the aborted receipt is durable, so this request may be retried."
        : "next: do not retry automatically; AKK could not prove a durable safe abort, so inspect this Turn and its tmux dispatch ledger."
    ].join("\n");
  }
  if (result.status === "submission_pending_acceptance") {
    return [
      `AKK dispatched terminal input to ${agent}, but native acceptance is still pending.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry or report success; wait for acceptance or inspect the shared tmux pane."
    ].join("\n");
  }
  if (result.status === "submission_not_accepted") {
    return [
      `AKK proved that ${agent} did not accept the terminal draft.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry automatically; inspect the exact draft in the shared tmux pane."
    ].join("\n");
  }
  return [
    `AKK sent the task to ${agent} in the shared terminal.`,
    `session: ${sessionId}`,
    `turn: ${turnId}`,
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
  const rawCallbackDelivery = isRecord(result.conversation?.callback_delivery)
    ? result.conversation.callback_delivery
    : undefined;
  const summarizedCallbackDelivery = isRecord(summary.callback_delivery)
    ? summary.callback_delivery
    : undefined;
  const callbackDelivery = rawCallbackDelivery || summarizedCallbackDelivery
    ? {
        ...(rawCallbackDelivery ?? {}),
        ...(summarizedCallbackDelivery ?? {})
      }
    : undefined;
  const { sessionId, turnId } = publicTurnIdentity(result);
  const lines = [
    "AKK status:",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `agent: ${summary.agent ?? summary.executor?.kind ?? terminalStatus.agent ?? "unknown"}`,
    `status: ${summary.status ?? terminalStatus.activity_state ?? "unknown"}`
  ];
  if (callbackDelivery) {
    const callbackParts = [
      String(callbackDelivery.status ?? "unknown"),
      Number.isSafeInteger(Number(callbackDelivery.attempts))
        ? `attempt ${Number(callbackDelivery.attempts)}`
        : undefined,
      callbackDelivery.attempt_state === "in_flight"
        ? "in flight"
        : undefined,
      stringValue(callbackDelivery.next_attempt_at)
        ? `next retry ${stringValue(callbackDelivery.next_attempt_at)}`
        : undefined
    ].filter(Boolean);
    lines.push(`callback: ${callbackParts.join(", ")}`);
  }
  if (summary.request) {
    lines.push(`request: ${truncateText(summary.request, 180)}`);
  }
  if (result.about) {
    lines.push(`about: ${truncateText(result.about, 500)}`);
  }
  if (result.confidence) {
    lines.push(`confidence: ${result.confidence}`);
  }
  const limitations = Array.isArray(result.limitations)
    ? result.limitations.filter(Boolean)
    : [];
  if (limitations.length > 0) {
    lines.push(`limitations: ${limitations.slice(0, 3).join("; ")}`);
  }
  const screen = terminalScreenExcerpt(result);
  if (screen) {
    lines.push(`terminal screen:\n${screen}`);
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
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK monitoring renewed.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `inactivity timeout: ${result.agent_timeout_minutes ?? "unknown"} minutes`,
    `hard lifetime: ${result.agent_hard_timeout_minutes ?? "unknown"} minutes`,
    "No message or key was sent to the coding agent."
  ].join("\n");
}

function formatRetryCallbackCommandResult(result) {
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK callback delivered.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${result.conversation?.status ?? "unknown"}`,
    `attempts: ${result.conversation?.callback_delivery?.attempts ?? "unknown"}`
  ].join("\n");
}

function formatSendCommandResult(result) {
  const conversation = result.conversation ?? {};
  const conversationId = conversation.conversation_id ?? result.conversation_id ?? "unknown";
  const sessionId = conversation.session_id ?? result.session_id ?? conversationId;
  const turnId = conversation.turn_id ?? result.turn_id ?? conversationId;
  const status = conversation.status ?? result.status ?? "unknown";
  const nextAction = isRecord(result.openclaw_next_action) ? result.openclaw_next_action : undefined;
  if (result.status === "delivered_unfenced") {
    return [
      "AKK sent the terminal input but could not bind an exact native session.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${status}`,
      "next: do not retry or continue automatically; inspect the shared tmux pane and close this Turn before sending more work."
    ].join("\n");
  }
  if (result.submission_outcome === "uncertain") {
    return [
      "AKK terminal submission outcome is uncertain.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry automatically; inspect AKK status and the named tmux pane."
    ].join("\n");
  }
  if (result.submission_outcome === "aborted") {
    const safeToRetry =
      result.safe_to_retry === true && result.do_not_retry !== true;
    return [
      "AKK terminal submission was aborted before tmux input.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      safeToRetry
        ? "next: this request was not sent, the aborted receipt is durable, and it may be retried."
        : "next: do not retry automatically; inspect the Turn because a durable safe abort was not proven."
    ].join("\n");
  }
  if (result.submission_outcome === "pending_acceptance") {
    return [
      "AKK dispatched the terminal input but native acceptance is still pending.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry or report success; wait for acceptance or inspect the shared tmux pane."
    ].join("\n");
  }
  if (result.submission_outcome === "not_accepted") {
    return [
      "AKK proved that the agent did not accept the terminal draft.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry automatically; inspect the exact draft in the shared tmux pane."
    ].join("\n");
  }
  if (
    terminalSubmissionReported(result) &&
    !isAkkNativeSubmissionAccepted(result)
  ) {
    return [
      "AKK could not verify native agent acceptance for this terminal input.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry or report success; inspect the exact Turn receipt and shared tmux pane."
    ].join("\n");
  }
  const lines = [
    "AKK turn sent.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
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
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK cancel requested.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `agent: ${result.executor?.kind ?? conversation.executor?.kind ?? "unknown"}`,
    `status: ${conversation.status ?? (result.cancel_requested === true ? "cancel requested" : "not cancelled")}`
  ].join("\n");
}

function formatApproveCommandResult(result) {
  const conversation = result.conversation ?? {};
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    result.approved === true
      ? "AKK approved the current terminal request."
      : "AKK did not approve the terminal request.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${conversation.status ?? "unknown"}`,
    ...(result.reason ? [`reason: ${result.reason}`] : [])
  ].join("\n");
}

function formatCloseCommandResult(result) {
  if (result.source === "terminal_control") {
    const terminalControl = isRecord(result.terminal_control)
      ? result.terminal_control
      : {};
    if (result.terminal_dispatch_resolved !== true) {
      return [
        "AKK did not clear the unresolved terminal dispatch fence.",
        `terminal: ${terminalControl.target ?? "unknown"}`,
        ...(stringValue(result.transition_id)
          ? [`transition: ${stringValue(result.transition_id)}`]
          : []),
        `reason: ${stringValue(result.reason) ?? "the recorded lifecycle outcome could not be verified"}`,
        "This terminal remains blocked. Do not retry or continue automatically; inspect the pane and use the fresh recovery action from /akk list."
      ].join("\n");
    }
    return [
      "AKK cleared the unresolved terminal dispatch fence.",
      `terminal: ${terminalControl.target ?? "unknown"}`,
      ...(stringValue(result.transition_id)
        ? [`transition: ${stringValue(result.transition_id)}`]
        : [
            `previous turn: ${result.owner_turn_id ?? result.owner_conversation_id ?? "unknown"}`
          ]),
      "The coding agent and tmux pane remain open."
    ].join("\n");
  }
  const conversation = result.conversation ?? {};
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK Turn record closed.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${conversation.status ?? "unknown"}`
  ].join("\n");
}

function publicTurnIdentity(result) {
  const conversation = isRecord(result.conversation) ? result.conversation : {};
  const summary = isRecord(result.summary) ? result.summary : {};
  const compatibilityId =
    stringValue(conversation.conversation_id) ??
    stringValue(summary.conversation_id) ??
    stringValue(result.conversation_id);
  return {
    sessionId:
      stringValue(conversation.session_id) ??
      stringValue(summary.session_id) ??
      stringValue(result.session_id) ??
      compatibilityId ??
      "unknown",
    turnId:
      stringValue(conversation.turn_id) ??
      stringValue(summary.turn_id) ??
      stringValue(result.turn_id) ??
      compatibilityId ??
      "unknown"
  };
}

function buildStatusCliArgs(api, params) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = [
    "status",
    "--reconcile"
  ];
  pushTurnTarget(args, params);
  pushOptional(
    args,
    "--store-dir",
    resolvePluginStoreDir(config)
  );
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(params.idleTimeoutMinutes) ??
      numberString(api.pluginConfig?.idleTimeoutMinutes)
  );
  if (params.trace === true) {
    args.push("--trace");
  }
  return args;
}

function terminalScreenExcerpt(result): string | undefined {
  const screen = result.terminal_screen;
  const text = typeof screen === "string"
    ? screen
    : isRecord(screen)
      ? stringValue(screen.excerpt) ??
        stringValue(screen.text) ??
        stringValue(screen.content)
      : undefined;
  if (!text) {
    return undefined;
  }
  return text.length <= 1600
    ? text
    : `…${text.slice(-1599)}`;
}

async function runSendRequest(api, params, toolContext, messageId?: string) {
  const requestedType = Object.hasOwn(params, "type")
    ? stringValue(params.type)
    : "task";
  if (requestedType !== "task") {
    throw new Error(
      "ordinary send type must be task; use agent_knock_knock_respond for an in-flight response"
    );
  }
  if (Object.hasOwn(params, "session_id") && Object.hasOwn(params, "selector")) {
    throw new Error("ordinary send accepts only one of session_id or selector");
  }
  const sessionId = Object.hasOwn(params, "session_id")
    ? authoritativeManagedId(params.session_id, "session_id")
    : undefined;
  const selector = Object.hasOwn(params, "selector")
    ? requiredString(params.selector, "selector")
    : undefined;
  if (!sessionId && !selector) {
    return runDelegate(api, { ...params, messageId }, toolContext);
  }

  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
    "agent:main:main";
  const args = [
    "send"
  ];
  if (sessionId) {
    args.push("--session", sessionId);
  } else {
    args.push("--conversation", requiredString(selector, "selector"));
  }
  args.push(
    "--message",
    requiredString(params.request, "request"),
    "--background"
  );
  pushOptional(args, "--type", stringValue(params.type));
  pushOptional(args, "--message-id", messageId);
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(params.idleTimeoutMinutes) ??
      numberString(config.idleTimeoutMinutes)
  );
  pushOptional(
    args,
    "--agent-timeout-minutes",
    numberString(params.agentTimeoutMinutes) ??
      numberString(config.agentTimeoutMinutes)
  );
  pushOptional(
    args,
    "--agent-hard-timeout-minutes",
    numberString(params.agentHardTimeoutMinutes) ??
      numberString(config.agentHardTimeoutMinutes)
  );
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  return runCli(api, args);
}

function toolResult(
  result,
  {
    submissionErrors = false,
    normalizeTurnIdentity = true,
    forceError = false
  }: {
    submissionErrors?: boolean;
    normalizeTurnIdentity?: boolean;
    forceError?: boolean;
  } = {}
) {
  const normalized = normalizeTurnIdentity ? withTurnIdentity(result) : result;
  const submissionError = submissionErrors && isSubmissionError(normalized);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(normalized, null, 2)
      }
    ],
    details: normalized,
    ...(submissionError || forceError ? { isError: true } : {})
  };
}

function isBlockedTerminalDispatchResult(result: unknown): boolean {
  return Boolean(
    isRecord(result) &&
    result.source === "terminal_control" &&
    result.terminal_dispatch_resolved !== true
  );
}

function isSubmissionError(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (terminalSubmissionReported(result)) {
    return !isAkkNativeSubmissionAccepted(result);
  }
  return [
    "submission_unfenced",
    "submission_uncertain",
    "submission_aborted",
    "submission_pending_acceptance",
    "submission_not_accepted"
  ].includes(String(result.status ?? "")) ||
    ["uncertain", "aborted", "pending_acceptance", "not_accepted"].includes(
      String(result.submission_outcome ?? "")
    ) ||
    result.status === "delivered_unfenced";
}

function terminalSubmissionReported(result: Record<string, unknown>): boolean {
  return result.submission_outcome !== undefined ||
    result.delivery_receipt !== undefined ||
    result.delivered !== undefined;
}

function withTurnIdentity(result) {
  if (!isRecord(result)) {
    return result;
  }
  const sources = [
    { label: "result", value: result },
    { label: "result.conversation", value: result.conversation },
    { label: "result.summary", value: result.summary },
    { label: "result.message", value: result.message }
  ];
  const compatibilityId = consistentResultIdentity(
    "conversation_id",
    sources
  );
  const explicitSessionId = consistentResultIdentity("session_id", sources);
  const explicitTurnId = consistentResultIdentity("turn_id", sources);
  const hasModernIdentity = Boolean(explicitSessionId || explicitTurnId);
  if (hasModernIdentity && (!explicitSessionId || !explicitTurnId)) {
    throw new Error(
      "agent-knock-knock CLI returned a partial session_id/turn_id identity"
    );
  }
  if (hasModernIdentity && !compatibilityId) {
    throw new Error(
      "agent-knock-knock CLI returned modern identity without conversation_id"
    );
  }
  if (hasModernIdentity && compatibilityId !== explicitTurnId) {
    throw new Error(
      "agent-knock-knock CLI returned conversation_id that differs from turn_id"
    );
  }
  if (!hasModernIdentity && !compatibilityId) {
    return result;
  }
  if (
    !hasModernIdentity &&
    (
      compatibilityId?.startsWith("terminal:") ||
      stringValue(result.source) === "terminal" ||
      (
        isRecord(result.summary) &&
        stringValue(result.summary.source) === "terminal"
      )
    )
  ) {
    return result;
  }
  const sessionId = explicitSessionId ?? compatibilityId;
  const turnId = explicitTurnId ?? compatibilityId;
  return {
    ...result,
    session_id: sessionId,
    turn_id: turnId
  };
}

function consistentResultIdentity(field, sources) {
  const values = sources.flatMap(({ label, value }) => {
    if (!isRecord(value) || !Object.hasOwn(value, field)) {
      return [];
    }
    const identity = stringValue(value[field]);
    if (!identity) {
      throw new Error(
        `agent-knock-knock CLI returned invalid ${label}.${field}`
      );
    }
    return [{ label, identity }];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.identity !== expected.identity) {
      throw new Error(
        `agent-knock-knock CLI returned conflicting ${field} between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.identity;
}

async function runDelegate(api, params, toolContext) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const request = requiredString(params.request, "request");
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
    "agent:main:main";
  const args = [
    "delegate",
    "--request",
    request,
    "--background"
  ];

  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--message-id", stringValue(params.messageId));
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
  pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(config.agentTimeoutMinutes));
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));

  const parsed = withTurnIdentity(await runCliAsync(api, args));
  if (!isRecord(parsed)) {
    throw new Error("agent-knock-knock delegate returned a non-object result");
  }
  const conversationId = stringValue(parsed.conversation_id) ??
    (isRecord(parsed.conversation)
      ? stringValue(parsed.conversation.conversation_id)
      : undefined);
  const sessionId = stringValue(parsed.session_id);
  const turnId = stringValue(parsed.turn_id);
  if (!conversationId || !sessionId || !turnId) {
    throw new Error("agent-knock-knock delegate returned incomplete Turn identity");
  }
  const parsedConversation = isRecord(parsed.conversation)
    ? parsed.conversation
    : undefined;
  const parsedPaths = isRecord(parsed.paths) ? parsed.paths : undefined;
  const parsedTerminalControl = isRecord(parsed.terminal_control)
    ? parsed.terminal_control
    : undefined;
  const statePath =
    parsedConversation?.state_path ??
    parsedPaths?.statePath;
  const logPath =
    parsedConversation?.event_log_path ??
    parsedPaths?.logPath;
  const submissionUncertain = parsed.submission_outcome === "uncertain";
  const submissionAborted = parsed.submission_outcome === "aborted";
  const submissionAccepted = parsed.submission_outcome === "agent_accepted" &&
    parsed.delivery_receipt === "agent_accepted" &&
    parsed.delivered === true;
  const submissionNotAccepted = parsed.submission_outcome === "not_accepted";
  const submissionPending = !submissionAccepted &&
    !submissionUncertain &&
    !submissionAborted &&
    !submissionNotAccepted;
  const submissionUnfenced = parsed.status === "delivered_unfenced";
  const agent =
    (isRecord(parsedConversation?.executor)
      ? stringValue(parsedConversation.executor.kind)
      : undefined) ??
    stringValue(parsed.agent);
  return {
    status: submissionUnfenced
      ? "submission_unfenced"
      : submissionUncertain
      ? "submission_uncertain"
      : submissionAborted
        ? "submission_aborted"
        : submissionNotAccepted
          ? "submission_not_accepted"
          : submissionPending
            ? "submission_pending_acceptance"
            : "async_pending",
    submission_status: submissionUnfenced
      ? "submitted_unfenced"
      : submissionUncertain
      ? "uncertain"
      : submissionAborted
        ? "aborted"
        : submissionNotAccepted
          ? "not_accepted"
          : submissionPending
            ? "pending_acceptance"
            : "accepted",
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: turnId,
    conversation_status: parsedConversation?.status,
    state_path: statePath,
    event_log_path: logPath,
    agent,
    executor: parsedConversation?.executor,
    session:
      (isRecord(parsedConversation?.executor)
        ? parsedConversation.executor.session
        : undefined) ??
      parsedTerminalControl?.target,
    openclaw_session: openclawSession,
    launched: parsed.launched === true,
    replayed: parsed.replayed === true,
    background: parsed.background === true,
    pid: parsed.pid ?? parsedTerminalControl?.panePid ?? null,
    callback_method: CALLBACK_METHOD,
    ...(submissionUnfenced
      ? {
          submission_outcome: "submitted",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK sent the terminal input but could not fence later side effects to an exact native session. Do not retry or continue automatically; inspect the pane and close this Turn."
        }
      : submissionUncertain
      ? {
          submission_outcome: "uncertain",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK could not prove whether tmux accepted Enter. Do not retry automatically; inspect the exact AKK Turn record and shared terminal."
        }
      : submissionAborted
        ? parsed.safe_to_retry === true && parsed.do_not_retry !== true
          ? {
              submission_outcome: "aborted",
              safe_to_retry: true,
              do_not_retry: false,
              reason: parsed.reason,
              openclaw_next_action: parsed.openclaw_next_action,
              note:
                "AKK stopped before sending tmux input and durably proved a safe abort. The request may be retried."
            }
          : {
              submission_outcome: "aborted",
              safe_to_retry: false,
              do_not_retry: true,
              reason: parsed.reason,
              openclaw_next_action: parsed.openclaw_next_action,
              note:
                "AKK could not prove a durable safe abort. Do not retry automatically; inspect the exact Turn and terminal dispatch ledger."
            }
      : submissionNotAccepted
        ? {
            submission_outcome: "not_accepted",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved terminal transport but the exact draft is still present in the agent composer. Do not retry automatically; inspect the shared pane."
          }
      : submissionPending
        ? {
            submission_outcome: "pending_acceptance",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved only terminal transport and is still waiting for native agent acceptance. Do not retry or report the task as accepted."
          }
      : {
          openclaw_next_action: {
            action: "yield",
            reason:
              "The coding agent is working in the shared tmux terminal. End this OpenClaw turn now and wait for an Agent Knock Knock callback.",
            do_not:
              "Do not poll terminal internals while waiting. Further communication must use Agent Knock Knock tools so the same shared terminal remains authoritative.",
            expected_callback:
              "The callback will be injected and scheduled into this OpenClaw session by the agent-knock-knock.callback Gateway method."
          },
          note:
            "The task was sent to the shared tmux terminal. OpenClaw should yield now and wait for the scheduled callback turn."
        })
  };
}

function terminalMessageIdForToolCall({
  toolCallId: toolCallIdValue,
  sessionKey: sessionKeyValue,
  sessionId: sessionIdValue,
  toolName
}: {
  toolCallId: unknown;
  sessionKey: unknown;
  sessionId: unknown;
  toolName: "agent_knock_knock_send" | "agent_knock_knock_respond";
}): string | undefined {
  const toolCallId = stringValue(toolCallIdValue);
  if (!toolCallId) {
    return undefined;
  }
  const sessionKey = stringValue(sessionKeyValue) ?? "agent:main:main";
  // sessionId is the OpenClaw conversation incarnation. It changes across
  // /new and /reset even when sessionKey remains stable. Keep a literal null
  // fallback so retries with the same legacy context remain deterministic.
  const sessionId = stringValue(sessionIdValue) ?? null;
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionKey, sessionId, toolName, toolCallId]))
    .digest("hex");
  return `msg-openclaw-${digest}`;
}

function registerCliTool(
  api,
  {
    name,
    description,
    parameters,
    buildArgs,
    normalizeTurnIdentity = true,
    isErrorResult = (_result: unknown) => false
  }
) {
  api.registerTool(
    (toolContext) => ({
      label: toolLabel(name),
      name,
      description,
      parameters,
      async execute(toolCallId, params) {
        const result = runCli(
          api,
          buildArgs(
            isRecord(params) ? params : {},
            toolContext,
            toolCallId
          )
        );
        return toolResult(result, {
          submissionErrors: name === "agent_knock_knock_respond",
          normalizeTurnIdentity,
          forceError:
            typeof isErrorResult === "function" && isErrorResult(result) === true
        });
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
  const binPath = relayPathForApi(api);
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
  const binPath = relayPathForApi(api);
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

function relayPathForApi(api): string {
  return relayPathByApi.get(api) ?? defaultBinPath;
}

function callbackIdentity({ params, conversation, message, messageMetadata }) {
  const messageHasSessionId = isRecord(message) &&
    Object.hasOwn(message, "session_id");
  const messageHasTurnId = isRecord(message) &&
    Object.hasOwn(message, "turn_id");
  if (messageHasSessionId !== messageHasTurnId) {
    throw new Error(
      "modern callback messages require both session_id and turn_id"
    );
  }
  const identityMode = messageHasSessionId ? "modern" : "legacy";
  const sources = [
    { label: "message", value: message },
    { label: "message.metadata", value: messageMetadata },
    { label: "conversation", value: conversation },
    { label: "params", value: params }
  ];
  const explicitConversationId = consistentCallbackIdentity(
    "conversation_id",
    sources
  );
  const explicitTurnId = consistentCallbackIdentity("turn_id", sources);
  const explicitSessionId = consistentCallbackIdentity("session_id", sources);
  const hasModernIdentity = Boolean(explicitSessionId || explicitTurnId);
  if (hasModernIdentity && (!explicitSessionId || !explicitTurnId)) {
    throw new Error(
      "modern callbacks require both session_id and turn_id"
    );
  }
  if (hasModernIdentity && !explicitConversationId) {
    throw new Error(
      "modern callbacks require conversation_id as the Turn Store alias"
    );
  }
  if (hasModernIdentity && explicitConversationId !== explicitTurnId) {
    throw new Error(
      "callback conversation_id must equal turn_id for modern callback identities"
    );
  }
  if (!explicitConversationId) {
    throw new Error(
      "callback identity requires session_id and turn_id, or a legacy conversation_id"
    );
  }
  const turnId = explicitTurnId ?? explicitConversationId;
  const conversationId = explicitConversationId;
  const sessionId = explicitSessionId ?? explicitConversationId;
  return {
    conversationId,
    sessionId,
    turnId,
    identityMode
  };
}

function consistentCallbackIdentity(field, sources) {
  const values = sources.flatMap(({ label, value }) => {
    if (!isRecord(value) || !Object.hasOwn(value, field)) {
      return [];
    }
    const identity = stringValue(value[field]);
    if (!identity) {
      throw new Error(`callback ${label}.${field} must be a non-empty string`);
    }
    return [{ label, identity }];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.identity !== expected.identity) {
      throw new Error(
        `callback ${field} mismatch between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.identity;
}

function callbackSessionKey({ params, conversation, message, messageMetadata }) {
  const sessionKey = callbackStringField(
    "params.sessionKey",
    params,
    "sessionKey"
  );
  if (!sessionKey) {
    throw new Error("callback params.sessionKey is required");
  }

  const gatewaySession = consistentCallbackTarget(
    "Gateway session",
    [
      {
        label: "conversation.gateway_session",
        owner: conversation,
        field: "gateway_session"
      },
      {
        label: "message.gateway_session",
        owner: message,
        field: "gateway_session"
      },
      {
        label: "message.metadata.gateway_session",
        owner: messageMetadata,
        field: "gateway_session"
      }
    ]
  );
  const openclawSession = consistentCallbackTarget(
    "OpenClaw session",
    [
      {
        label: "params.openclaw_session",
        owner: params,
        field: "openclaw_session"
      },
      {
        label: "conversation.openclaw_session",
        owner: conversation,
        field: "openclaw_session"
      },
      {
        label: "message.openclaw_session",
        owner: message,
        field: "openclaw_session"
      },
      {
        label: "message.metadata.openclaw_session",
        owner: messageMetadata,
        field: "openclaw_session"
      }
    ]
  );
  const expectedGatewayTarget = gatewaySession ?? openclawSession;
  if (expectedGatewayTarget && expectedGatewayTarget !== sessionKey) {
    throw new Error(
      "callback Gateway session mismatch with params.sessionKey"
    );
  }
  return sessionKey;
}

function consistentCallbackTarget(label, sources) {
  const values = sources.flatMap((source) => {
    const value = callbackStringField(source.label, source.owner, source.field);
    return value ? [{ label: source.label, value }] : [];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.value !== expected.value) {
      throw new Error(
        `callback ${label} mismatch between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.value;
}

function callbackStringField(label, owner, field) {
  if (!isRecord(owner) || !Object.hasOwn(owner, field)) {
    return undefined;
  }
  const value = stringValue(owner[field]);
  if (!value) {
    throw new Error(`callback ${label} must be a non-empty string`);
  }
  return value;
}

async function handleCallback(api, params) {
  if (!isRecord(params)) {
    throw new Error("callback params must be an object");
  }

  const message = isRecord(params.message) ? params.message : undefined;
  const conversation = isRecord(params.conversation) ? params.conversation : undefined;
  const messageMetadata = isRecord(message?.metadata) ? message.metadata : undefined;
  if (!message) {
    throw new Error("callback params.message is required");
  }
  const sessionKey = callbackSessionKey({
    params,
    conversation,
    message,
    messageMetadata
  });

  const {
    conversationId,
    sessionId,
    turnId,
    identityMode
  } = callbackIdentity({ params, conversation, message, messageMetadata });
  const messageId = stringValue(message.id);
  if (!messageId) {
    throw new Error("callback message.id is required");
  }
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
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      auto_approved: autoApproval.approved === true,
      approval_already_handled:
        autoApproval.action === "already_approved",
      approval: autoApproval
    };
  }
  const formatted = formatCallbackInjection({
    message,
    sessionId,
    turnId,
    statePath: stringValue(params.statePath)
  });
  const dedupeIdentity = identityMode === "legacy"
    ? conversationId
    : `${sessionId}:${turnId}`;
  const injection = await api.session.workflow.enqueueNextTurnInjection({
    sessionKey,
    text: formatted,
    idempotencyKey: `agent-knock-knock:${dedupeIdentity}:${messageId}`,
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: conversationId,
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      state_path: stringValue(params.statePath),
      log_path: stringValue(params.logPath)
    }
  });
  const delivery = buildCallbackDeliveryPlan({
    sessionKey,
    conversationId,
    sessionId,
    turnId,
    identityMode,
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
    session_id: sessionId,
    turn_id: turnId,
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
    execute: (args) => {
      return runCli(api, args);
    }
  });
  if (result) {
    api.logger.info?.(
      `agent-knock-knock approval policy for ${conversationId ?? "unknown"}: ${result.action} (${result.reason})`
    );
  }
  return result;
}

function buildCallbackDeliveryPlan({
  sessionKey,
  conversationId,
  sessionId,
  turnId,
  identityMode,
  messageId,
  message,
  formatted
}) {
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

  const dedupeIdentity = identityMode === "legacy"
    ? conversationId
    : `${sessionId}:${turnId}`;
  return {
    required: true,
    mode: "chat.send",
    chat_send: {
      sessionKey,
      message: [
        "Continue this OpenClaw product-manager conversation from the Agent Knock Knock callback below.",
        "Treat the callback as a structured message from the coding agent's managed terminal turn, not as a terminal log, status announcement, or instruction to inspect local state.",
        "Respond in this conversation as OpenClaw product manager. If the callback is question or blocked, make the product decision and use agent_knock_knock_respond with its exact turn_id. If it is done, summarize the result to the user.",
        "Do not poll files, processes, sessions, stdout, or stderr. Use only the structured callback payload below.",
        "",
        formatted
      ].join("\n"),
      idempotencyKey: `agent-knock-knock-callback:${dedupeIdentity}:${messageId}`,
      deliver: true
    }
  };
}

function formatCallbackInjection({ message, sessionId, turnId, statePath }) {
  const type = stringValue(message.type) ?? "unknown";
  const body = stringValue(message.body) ?? JSON.stringify(message.body ?? "");
  const requiresResponse = message.requires_response === true ? "yes" : "no";
  const round = typeof message.round === "number" ? String(message.round) : "unknown";
  const stateLine = statePath ? `State: ${statePath}\n` : "";
  const shortcuts = type === "done"
    ? formatDoneShortcuts(sessionId, turnId)
    : message.requires_response === true || type === "question" || type === "blocked"
      ? formatRespondShortcut(turnId)
      : "";

  return [
    "[Agent Knock Knock callback]",
    `Session: ${sessionId}`,
    `Turn: ${turnId}`,
    `Message type: ${type}`,
    `Requires OpenClaw response: ${requiresResponse}`,
    `Round: ${round}`,
    stateLine.trimEnd(),
    "",
    body,
    shortcuts
  ].filter((line) => line !== "").join("\n");
}

function formatDoneShortcuts(sessionId, turnId) {
  return [
    "",
    "[AKK convenience commands]",
    "When summarizing this result to the user, include these short next-step commands:",
    "- `AKK list` lists live shared terminals with their current or recent managed turns.",
    `- Use \`agent_knock_knock_send\` with \`session_id: ${JSON.stringify(sessionId)}\` to start a later turn in the same coding-agent context.`,
    `- Use \`agent_knock_knock_status\` with \`turn_id: ${JSON.stringify(turnId)}\` to inspect this exact turn.`,
    "- AKK never starts or closes the coding agent or tmux pane."
  ].join("\n");
}

function formatRespondShortcut(turnId) {
  return [
    "",
    "[AKK response command]",
    `- Use \`agent_knock_knock_respond\` with \`turn_id: ${JSON.stringify(turnId)}\` and your decision in \`request\`. Do not use ordinary send for this response.`
  ].join("\n");
}

function pushTurnTarget(args, params) {
  if (Object.hasOwn(params, "turn_id") && Object.hasOwn(params, "conversation_id")) {
    throw new Error("turn-target tools accept only one of turn_id or conversation_id");
  }
  const turnId = stringValue(params.turn_id);
  if (turnId) {
    args.push("--turn", authoritativeManagedId(turnId, "turn_id"));
    return;
  }
  args.push(
    "--conversation",
    requiredString(params.conversation_id, "turn_id")
  );
}

function authoritativeManagedId(value, name) {
  const id = requiredString(value, name).trim();
  if (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(id) ||
    /^@[0-9a-f]+$/iu.test(id) ||
    /^terminal:/iu.test(id)
  ) {
    throw new Error(
      `${name} must be an authoritative managed id, not a discovery selector or terminal id`
    );
  }
  return id;
}

function assertExclusiveRecoveryFence(params) {
  if (
    stringValue(params.expected_message_id) &&
    stringValue(params.expected_transition_id)
  ) {
    throw new Error(
      "close accepts only one of expected_message_id or expected_transition_id"
    );
  }
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
    throw new Error(`agent-knock-knock CLI returned invalid JSON: ${error.message}`);
  }
}

function cleanError(text) {
  return String(text).trim().slice(0, 2000);
}

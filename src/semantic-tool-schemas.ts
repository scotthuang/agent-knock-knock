import { EXECUTOR_KINDS } from "./executors.js";
import { TERMINAL_INTERACTION_LIMITS } from
  "./terminal-interaction-protocol.js";

const terminalOrDesktopConversationSchema = {
  type: "string", pattern: "^(?:(?:desktop|claude-cli):v1:[A-Za-z0-9_-]+|terminal:v[0-9]+:\\S+)$",
  description: "Exact listed Desktop or terminal conversation_id; AKK selects the supported route."
};
const listedConversationSchema = {
  type: "string", pattern: "^(?:(?:desktop|codex-cli|claude-cli):v1:[A-Za-z0-9_-]+|terminal:v[0-9]+:\\S+)$",
  description: "Exact conversation_id from List. AKK chooses the available transport; never construct an ID."
};
const terminalOrNativeTarget = [
  { required: ["terminal_id"], not: { required: ["conversation_id"] } },
  { required: ["conversation_id"], not: { required: ["terminal_id"] } }
];

const terminalInteractionIdentifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: TERMINAL_INTERACTION_LIMITS.maxIdentifierLength,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
};

const terminalInteractionAnswerBase = {
  question_id: {
    ...terminalInteractionIdentifierSchema,
    description:
      "Opaque semantic question_id from the current interaction_state projection."
  }
};

const terminalAnswerConstraints = {
  maxItems: TERMINAL_INTERACTION_LIMITS.maxQuestions,
  items: { properties: { text: { pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" } } }
};

export const respondInteractionParameters = {
  type: "object",
  additionalProperties: false,
  required: ["interaction_id", "answers"],
  oneOf: [
    {
      required: ["turn_id"],
      not: { anyOf: [{ required: ["watch_id"] }, { required: ["conversation_id"] }] },
      properties: { answers: terminalAnswerConstraints }
    },
    {
      required: ["watch_id"],
      not: { anyOf: [{ required: ["turn_id"] }, { required: ["conversation_id"] }] },
      allOf: [{ if: { properties: { watch_id: { pattern: "^terminal-watch-" } } },
        then: { properties: { answers: terminalAnswerConstraints } } }]
    },
    { required: ["conversation_id"], not: { anyOf: [{ required: ["turn_id"] }, { required: ["watch_id"] }] } }
  ],
  allOf: [{ if: { required: ["conversation_id"], properties: { conversation_id: { pattern: "^terminal:" } } },
    then: { properties: { interaction_id: { pattern: "^codex-native-interaction:[0-9a-f]{64}$" } } } }, {
    if: { anyOf: [{ required: ["conversation_id"] }, { required: ["watch_id"] }], properties: {
      conversation_id: { pattern: "^desktop:v1:" }, watch_id: { pattern: "^desktop-watch:" }
    } },
    then: { properties: {
      delivery_mode: { enum: ["steer_current_turn"] },
      answers: { maxItems: 16, items: { properties: { response_kind: { enum: ["single_select", "free_text"] } } } }
    } }
  }] as const,
  properties: {
    conversation_id: listedConversationSchema,
    turn_id: {
      ...terminalInteractionIdentifierSchema,
      description:
        "Exact authoritative Turn id from the current interaction_state projection."
    },
    watch_id: {
      ...terminalInteractionIdentifierSchema,
      description:
        "Exact terminal, Desktop, or direct Codex CLI Watch id from the current interaction_state " +
          "projection. Supply exactly one of turn_id, watch_id, or Desktop/direct CLI conversation_id."
    },
    interaction_id: {
      ...terminalInteractionIdentifierSchema,
      description:
        "Exact opaque interaction id from the current status response in this controller conversation."
    },
    delivery_mode: {
      type: "string",
      enum: ["steer_current_turn", "queue_next_turn"],
      description:
        "Optional for async_question; defaults to steer_current_turn when advertised. " +
          "Use only a delivery mode advertised by the current interaction_state: " +
          "steer_current_turn delivers the answer to the running turn; queue_next_turn " +
          "queues it for the next turn. Omit for blocking questionnaire interactions."
    },
    answers: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      description:
        "Typed answers using only advertised opaque semantic ids: one current step " +
          "for terminal interactions, every question in one Desktop or direct CLI request. For " +
          "single_select supply selected_option_ids; for free_text supply text; for " +
          "confirm supply confirm. Async questions optionally select top-level " +
          "delivery_mode (default: steer_current_turn). Supply no other answer field. " +
          "Raw keys, indexes, rendered labels, fingerprints, versions, and terminal " +
          "commands are not accepted.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question_id", "response_kind"],
        description:
          "Provider-portable answer envelope. AKK revalidates the exact " +
            "discriminator-specific shape against the current authoritative interaction " +
            "before dispatching an answer.",
        properties: {
          ...terminalInteractionAnswerBase,
          response_kind: {
            type: "string",
            enum: ["single_select", "free_text", "confirm"],
            description:
              "Exact response_kind advertised for the current question. multi_select remains manual-only and is not accepted here."
          },
          selected_option_ids: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            uniqueItems: true,
            items: terminalInteractionIdentifierSchema,
            description:
              "Required only for single_select; exactly one advertised opaque option_id."
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: TERMINAL_INTERACTION_LIMITS.maxTextAnswerLength,
            pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+$",
            description:
              "Required only for free_text. Desktop and direct Codex CLI JSON answers allow newlines and tabs; terminal answers require one non-empty line without control characters."
          },
          confirm: {
            type: "boolean",
            description: "Required only for confirm."
          }
        }
      }
    }
  }
};

export const sendParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: [
    {
      required: ["request"],
      not: { required: ["turn_id"] }
    },
    {
      required: ["turn_id"],
      not: {
        anyOf: [
          { required: ["request"] },
          { required: ["session_id"] },
          { required: ["terminal_id"] },
          { required: ["type"] },
          { required: ["idleTimeoutMinutes"] },
          { required: ["agentTimeoutMinutes"] },
          { required: ["agentHardTimeoutMinutes"] }
        ]
      }
    }
  ],
  not: { anyOf: [
    { required: ["session_id", "terminal_id"] },
    { required: ["conversation_id", "terminal_id"] },
    { required: ["conversation_id", "session_id"] },
    { required: ["conversation_id", "turn_id"] }
  ] },
  properties: {
    conversation_id: {
      ...listedConversationSchema,
      description: "Exact conversation_id from List. AKK prefers the backend when it proves the same live thread; otherwise eligible terminal delivery remains available. Read the actual acceptance and Watch receipt. Never repeat an uncertain send."
    },
    turn_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact authoritative Turn id only from a current " +
          "available_actions.retry_submission action. This retry form is exactly " +
          "{turn_id}: the caller never supplies request text, terminal or Session " +
          "target, timeout override, or callback route. AKK may use only the immutable " +
          "original request, and only after revalidating the durable submission and " +
          "live composer under lock."
    },
    session_id: {
      type: "string",
      minLength: 1,
      description:
        "Strict session-scoped AKK id only when the current list action prefills it. " +
          "This preserves that exact native context and never follows the pane after a " +
          "human switches threads. A rollout-backed Codex Session is a continuing " +
          "context label but is not a direct ordinary-send target; use that terminal " +
          "row's follow-current selector action instead. Discovery selectors, terminal " +
          "ids, and turn ids are never session_id destinations."
    },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal-scoped send action. Codex " +
          "and Claude Code terminal_user_explicit identify one exact live physical " +
          "terminal/process with a scanned, non-blocked approval state and no proven " +
          "input-owning questionnaire, editor, menu, or read-only viewer. Composer " +
          "visibility, stability, exactness, existing draft contents, and parsed " +
          "working activity are not eligibility vetoes. Codex sends C-u once; Claude " +
          "Code uses a sentinel-backed native C-s stash-clear transaction that is " +
          "independent of the cursor position and does not interrupt an active turn, " +
          "then proves the main Composer empty. Each then injects this request, waits " +
          "through the paste window, and dispatches Enter exactly once without a " +
          "post-text Composer veto. Broken AKK state cannot veto the user; unmanaged " +
          "delivery has no managed callback Turn, but AKK best-effort attaches an exact " +
          "Terminal Watch callback before management release. Watch failure is reported " +
          "without changing a successful Send. Once mutation begins, an uncertain " +
          "result must not be retried automatically. Human discovery selectors are not " +
          "structured-tool authority. Omit both target fields only when AKK should " +
          "select the unique send-ready pane."
    },
    request: {
      type: "string",
      minLength: 1,
      description:
        "Message for the coding agent. Each accepted ordinary send creates a new turn " +
          "inside the selected session without clearing native agent context."
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

export const respondParameters = {
  type: "object",
  additionalProperties: false,
  required: ["turn_id", "request"],
  properties: {
    turn_id: {
      type: "string",
      description:
        "Authoritative AKK turn id from a question or blocked callback, never a " +
          "discovery selector or terminal id. A response continues this exact in-flight " +
          "turn and does not create a new turn."
    },
    request: {
      type: "string",
      description: "Answer or decision for the coding agent's exact in-flight turn."
    }
  }
};

export const listParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    desktop_view: { type: "string", enum: ["sidebar", "history"], description: "Desktop discovery scope: sidebar (default) follows persisted expanded sidebar membership, not the current scroll viewport; history searches the broader saved catalog. Unconnected rows remain listed." },
    desktopSearch: { type: "string", description: "Search saved Desktop candidates by title, directory or native thread ID; unconfirmed live connections remain listed." },
    desktopProject: { type: "string", description: "Exact Desktop project ID or absolute directory." },
    desktopCursor: { type: "string", description: "Opaque next_cursor from the preceding Desktop page for the same view and filters." },
    desktopLimit: { type: "integer", minimum: 1, maximum: 100, description: "Desktop page size (default 30)." },
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
      description: "When true, include terminal-provider discovery diagnostics for debugging Gateway environment issues."
    },
    idleTimeoutMinutes: {
      type: "number"
    }
  }
};

export const watchParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: [{ required: ["terminal_id"], not: { required: ["conversation_id"] } },
    { required: ["conversation_id"], not: { required: ["terminal_id"] } }],
  properties: {
    conversation_id: { ...listedConversationSchema,
      description: "Exact conversation_id from List. AKK chooses the available backend or terminal observation path. Use the returned watch_id for this observation; activity-only fallback does not prove exact task completion." },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id selected by the user, normally copied from the " +
          "current terminal row. AKK prefers an exact backend task, resolving an idle alias " +
          "with a safe native status probe when needed; otherwise eligible terminal " +
          "observation reports its exact-task or best-effort evidence."
    },
    hardTimeoutMinutes: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "Optional maximum lifetime for observing this exact terminal, Desktop, or direct Codex/Claude CLI task."
    }
  }
};

export const unwatchParameters = {
  type: "object",
  additionalProperties: false,
  required: ["watch_id"],
  properties: {
    watch_id: {
      type: "string",
      minLength: 1,
      description:
        "Authoritative terminal, Desktop, or direct Codex/Claude CLI Watch id returned by watch or prefilled by list/status."
    }
  }
};

export const listResumableThreadsParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the selected terminal row's current " +
          "available_actions. Do not use a short ref, session id, turn id, or " +
          "constructed selector."
    }
  }
};

export const nativeInspectParameters = {
  type: "object",
  additionalProperties: false,
  required: ["inspection"],
  oneOf: terminalOrNativeTarget,
  properties: {
    conversation_id: listedConversationSchema,
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current native_inspect action. Never use a " +
          "short ref, Session id, Turn id, or constructed selector. AKK refreshes and " +
          "revalidates the binding internally."
    },
    inspection: {
      type: "string",
      enum: ["status"],
      description:
        "Closed adapter-owned inspection kind. Codex " +
          "0.146.0/0.146.1/0.147.0/0.148.0/0.149.1/0.150.1/0.151.0/0.153.0/0.153.4/0.15" +
          "4.0/0.155.1 and Claude Code " +
          "2.1.218/2.1.226/2.1.237/2.1.251/2.1.259/2.1.263/2.1.266/2.1.267/2.1.285 are " +
          "regression-tested; another complete x.y.z version remains callable through " +
          "the generic runtime profile with a compatibility warning. This is never an " +
          "arbitrary native command string."
    }
  }
};

export const modelOptionsParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: terminalOrNativeTarget,
  properties: {
    conversation_id: terminalOrDesktopConversationSchema,
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal row's advertised " +
          "model_options action. This is explicit current-snapshot authority for one " +
          "live physical pane/process, including a profiled Codex 0.154.0/0.155.1 pane " +
          "with no materialized rollout or one exact stable /model residual. AKK " +
          "consumes any residual-entry authority during this closed discovery; after " +
          "exact dismissal it retains only a fresh ordinary terminal/catalog offer for " +
          "one set_model attempt."
    }
  }
};

export const permissionOptionsParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: terminalOrNativeTarget,
  properties: {
    conversation_id: listedConversationSchema,
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description: "Exact full terminal_id from the current terminal row's advertised " +
        "permission_options action. AKK prefers the exact backend; terminal fallback requires " +
        "an idle empty Composer and verified physical/native identities."
    }
  }
};

export const setPermissionsParameters = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  oneOf: terminalOrNativeTarget,
  properties: {
    conversation_id: listedConversationSchema,
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description: "Exact full terminal_id used for the immediately preceding permission_options result in this controller conversation."
    },
    mode: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]*$",
      description: "Exact semantic mode id from the current native permission catalog for the " +
        "requested or authorized change. Full Access is an ordinary option with no " +
        "additional user confirmation; AKK handles its native dialog automatically. " +
        "Labels, menu indexes, slash commands, keys, arbitrary profiles, and " +
        "configuration paths are not accepted."
    }
  }
};

export const repairModelControlParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal row's advertised " +
          "repair_model_control action. AKK privately binds this one-shot repair to the " +
          "exact profiled Codex 0.154.0/0.155.1 pane/process and exact native /model " +
          "Composer residue or open model picker; no command, key, menu index, draft " +
          "text, token, or fingerprint is accepted."
    }
  }
};

export const setModelParameters = {
  type: "object",
  additionalProperties: false,
  required: ["model", "reasoning_effort"],
  oneOf: terminalOrNativeTarget,
  allOf: [{ if: { required: ["terminal_id"] }, then: { not: { required: ["collaboration_mode"] } } }],
  properties: {
    conversation_id: terminalOrDesktopConversationSchema,
    collaboration_mode: { type: "string", enum: ["plan", "default"],
      description: "Desktop only: optional current-thread collaboration mode. Omit to retain the current mode." },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full physical-pane terminal_id used in the immediately preceding " +
          "agent_knock_knock_model_options call in this controller conversation. For a " +
          "verified-zero-rollout profiled Codex 0.154.0/0.155.1 pane, foreground " +
          "attribution and identify_foreground are not prerequisites; Claude Code still " +
          "requires its exact current native Session."
    },
    model: {
      type: "string",
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/+\\-]*$",
      description:
        "For Desktop, the explicit model id requested by the user; its IPC exposes no model catalog, so do not infer available models. For a terminal, an exact id advertised by the current model-options catalog. " +
          "Display labels, menu indexes, slash commands, keys, and constructed model " +
          "names are not accepted."
    },
    reasoning_effort: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_-]*$",
      description:
        "For Desktop, the explicitly requested effort; for terminals, the effort advertised for this model. The full " +
          "model/effort tuple is required so AKK can verify an unambiguous " +
          "postcondition."
    }
  }
};

export const identifyForegroundParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full Codex terminal_id from the current identify_foreground action. " +
          "AKK sends the closed /status probe exactly once under the terminal lock and " +
          "returns only a short-lived diagnostic foreground observation. It does not " +
          "bind a Session or authorize later input."
    }
  }
};

export const identifyAndSendParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id", "request"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full Codex terminal_id from the current identify_and_send action. AKK " +
          "keeps one terminal lock from the explicit /status foreground probe through " +
          "the single task dispatch; final durable identity still comes only from exact " +
          "request acceptance."
    },
    request: {
      type: "string",
      minLength: 1,
      description:
        "Task text sent exactly once after the foreground probe remains current."
    },
    idleTimeoutMinutes: {
      type: "number",
      description:
        "Minutes a completed or idle AKK Turn record is retained before controlled reconciliation closes it."
    },
    agentTimeoutMinutes: {
      type: "number",
      description: "Callback inactivity timeout in minutes."
    },
    agentHardTimeoutMinutes: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Maximum terminal monitor lifetime in minutes."
    }
  }
};

export const newThreadParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current new_thread action. AKK refreshes and " +
          "revalidates the lifecycle binding internally."
    }
  }
};

export const reconcileBindingParameters = {
  type: "object",
  additionalProperties: false,
  required: [
    "terminal_id",
    "conflicting_session_id"
  ],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current reconcile_binding action."
    },
    conflicting_session_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact conflicting managed Session id prefilled by AKK list. Never choose or construct one independently."
    }
  }
};

export const resumeThreadParameters = {
  type: "object",
  additionalProperties: false,
  required: [
    "terminal_id",
    "native_thread_id"
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
        "Complete native thread UUID from a resumable=true row returned for this " +
          "exact terminal. Never truncate, guess, or select an unavailable row."
    }
  }
};

const backendWatchSchema = {
  type: "string", pattern: "^(?:desktop-watch|codex-cli-watch|claude-cli-watch):[A-Za-z0-9_-]{8,128}$",
  description: "Exact persisted Claude CLI, Codex CLI or Desktop task watch_id. Never use a conversation or current/latest selector."
};
const recoveryTargetChoice = [
  { required: ["watch_id"], not: { anyOf: [{ required: ["turn_id"] }, { required: ["conversation_id"] }] } },
  { required: ["turn_id"], not: { anyOf: [{ required: ["watch_id"] }, { required: ["conversation_id"] }] } },
  { required: ["conversation_id"], not: { anyOf: [{ required: ["watch_id"] }, { required: ["turn_id"] }] } }
];
const legacyRecoveryConversation = {
  type: "string", minLength: 1, pattern: "^(?!(?:desktop|codex-cli|claude-cli)(?:-watch)?:)", deprecated: true,
  description: "Deprecated legacy terminal Turn alias only. Backend conversation_id cannot target task recovery."
};

export const renewParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: recoveryTargetChoice,
  properties: {
    watch_id: backendWatchSchema,
    turn_id: {
      type: "string", minLength: 1, pattern: "^(?!(?:desktop|codex-cli|claude-cli):)",
      description: "Exact managed terminal Turn or send-produced backend turn_id (the original task's Watch ID)."
    },
    conversation_id: legacyRecoveryConversation,
    minutes: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Positive monitoring extension in minutes: backend task deadline or terminal inactivity timeout."
    }
  }
};

export const recoverParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: [
    { required: ["watch_id"], not: { required: ["turn_id"] } },
    { required: ["turn_id"], not: { required: ["watch_id"] } }
  ],
  properties: {
    watch_id: backendWatchSchema,
    turn_id: { ...backendWatchSchema, description: "Exact send-produced backend turn_id, which aliases the original task's Watch ID." }
  }
};

export const retryCallbackParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: recoveryTargetChoice,
  allOf: [{ if: { required: ["notification_id"] }, then: { anyOf: [
    { required: ["watch_id"] },
    { required: ["turn_id"], properties: { turn_id: { pattern: "^(?:desktop-watch|codex-cli-watch|claude-cli-watch):[A-Za-z0-9_-]{8,128}$" } } }
  ] } }],
  properties: {
    watch_id: backendWatchSchema,
    turn_id: {
      type: "string", minLength: 1, pattern: "^(?!(?:desktop|codex-cli|claude-cli):)",
      description: "Exact managed terminal Turn or send-produced backend turn_id whose persisted callback should be retried."
    },
    conversation_id: legacyRecoveryConversation,
    notification_id: {
      type: "string", minLength: 1,
      description: "Backend only: exact notification_id from Status. Omit only when exactly one notification is eligible; accepted, uncertain, or leased delivery cannot be retried."
    }
  }
};

export const statusParameters = {
  type: "object",
  additionalProperties: false,
  not: {
    anyOf: [
      { required: ["turn_id", "conversation_id"] },
      { required: ["turn_id", "watch_id"] },
      { required: ["conversation_id", "watch_id"] }
    ]
  },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] },
    { required: ["watch_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id to inspect."
    },
    conversation_id: {
      type: "string",
      description:
        "Exact direct Codex/Claude CLI or Desktop conversation_id from List, or the exact raw-terminal selector " +
          "prefilled by that terminal row's available status action. Legacy Turn aliases " +
          "remain supported but deprecated; managed Turn status must use turn_id. " +
          "Never construct a Desktop identity; never construct or guess a raw-terminal selector."
    },
    watch_id: {
      type: "string",
      minLength: 1,
      description:
        "Authoritative terminal, direct Codex/Claude CLI, or Desktop Watch id prefilled by a current watch row. This " +
          "inspects externally started work and is mutually exclusive with Turn " +
          "targets."
    },
    idleTimeoutMinutes: {
      type: "number"
    },
    trace: {
      type: "boolean",
      description: "Include a safe executor trace summary with tool calls, permission requests, " +
        "monitor events, and redacted thinking markers."
    }
  }
};

export const cancelParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: [
    { required: ["turn_id"], not: { anyOf: [{ required: ["conversation_id"] }, { required: ["watch_id"] }] } },
    { required: ["conversation_id"], not: { anyOf: [{ required: ["turn_id"] }, { required: ["watch_id"] }] } },
    { required: ["watch_id"], not: { anyOf: [{ required: ["turn_id"] }, { required: ["conversation_id"] }] } }
  ],
  allOf: [{
    if: { required: ["conversation_id"], properties: { conversation_id: { pattern: "^desktop:v1:" } } },
    then: { required: ["expected_native_turn_id"], not: { required: ["idleTimeoutMinutes"] } },
    else: { not: { required: ["expected_native_turn_id"] } }
  }, { if: { required: ["watch_id"] }, then: { not: { required: ["idleTimeoutMinutes"] } } }],
  properties: {
    turn_id: { type: "string", description: "Authoritative AKK turn id to interrupt." },
    watch_id: { type: "string", pattern: "^desktop-watch:[A-Za-z0-9_-]{8,128}$",
      description: "Exact Desktop Watch; interrupt only its anchored native task, never a later task." },
    conversation_id: { type: "string", description: "Exact Desktop conversation plus expected_native_turn_id from Status; otherwise a legacy Turn alias or the list-prefilled unmanaged terminal cancel selector." },
    expected_native_turn_id: { ...terminalInteractionIdentifierSchema,
      description: "Desktop conversation only: exact native_turn_id from current Status. A changed task is rejected." },
    idleTimeoutMinutes: { type: "number" }
  }
};

export const closeParameters = {
  type: "object",
  additionalProperties: false,
  oneOf: recoveryTargetChoice,
  not: { required: ["expected_message_id", "expected_transition_id"] },
  allOf: [{
    if: { anyOf: [
      { required: ["watch_id"] },
      { required: ["turn_id"], properties: { turn_id: { pattern: "^(?:desktop-watch|codex-cli-watch|claude-cli-watch):" } } }
    ] },
    then: { not: { anyOf: [{ required: ["expected_message_id"] }, { required: ["expected_transition_id"] }] } }
  }],
  properties: {
    watch_id: { ...backendWatchSchema, description: "Exact send-managed backend task Watch ID to release from AKK management. Passive Watches use unwatch." },
    turn_id: {
      type: "string", minLength: 1, pattern: "^(?!(?:desktop|codex-cli|claude-cli):)",
      description: "Exact managed terminal Turn or send-produced backend turn_id whose management should be closed."
    },
    conversation_id: {
      ...legacyRecoveryConversation,
      description:
        "Deprecated legacy Turn alias, or an exact list-prefilled raw-terminal/orphan " +
          "recovery selector. Managed Turn close must use turn_id; never construct or " +
          "guess a raw-terminal selector."
    },
    reason: {
      type: "string"
    },
    expected_message_id: {
      type: "string",
      description:
        "Required only to clear an orphaned terminal dispatch shown by AKK list. Must " +
          "exactly match that entry's current message_id and must not be combined with " +
          "expected_transition_id."
    },
    expected_transition_id: {
      type: "string",
      description:
        "Required only to recover an unresolved native-thread lifecycle transition " +
          "shown by AKK list. Must exactly match that entry's current transition_id and " +
          "must not be combined with expected_message_id."
    }
  }
};

export const approveParameters = {
  type: "object",
  additionalProperties: false,
  not: { anyOf: [
    { required: ["turn_id", "terminal_id"] }, { required: ["turn_id", "conversation_id"] },
    { required: ["turn_id", "watch_id"] }, { required: ["terminal_id", "conversation_id"] },
    { required: ["terminal_id", "watch_id"] }, { required: ["conversation_id", "watch_id"] }
  ] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["terminal_id"] },
    { required: ["conversation_id", "interaction_id"] },
    { required: ["watch_id", "interaction_id"] }
  ],
  properties: {
    conversation_id: listedConversationSchema,
    watch_id: { type: "string", pattern: "^(?:desktop-watch|codex-cli-watch|claude-cli-watch):[A-Za-z0-9_-]{8,128}$",
      description: "Exact Desktop or direct Codex CLI Watch whose Status advertises this approval." },
    interaction_id: { ...terminalInteractionIdentifierSchema,
      description: "Required for Desktop or direct CLI approval: exact currently pending interaction_id from Status." },
    decision: {
      type: "string",
      enum: ["approve_once", "reject"],
      description:
        "Closed semantic decision from the current AKK status offer. Defaults to " +
          "approve_once. Raw keys, menu indexes, and rendered labels are never " +
          "accepted."
    },
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id containing the approval prompt."
    },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal-scoped approval action. " +
          "Managed Turn approval must use turn_id. AKK binds the user's reviewed prompt " +
          "and revalidates terminal authority internally."
    }
  }
};

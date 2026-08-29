import { EXECUTOR_KINDS } from "./executors.js";

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
  not: { required: ["session_id", "terminal_id"] },
  properties: {
    turn_id: {
      type: "string",
      minLength: 1,
      description:
        "Exact authoritative Turn id only from a current available_actions.retry_submission action. This retry form is exactly {turn_id}: the caller never supplies request text, terminal or Session target, timeout override, or callback route. AKK may use only the immutable original request, and only after revalidating the durable submission and live composer under lock."
    },
    session_id: {
      type: "string",
      minLength: 1,
      description:
        "Strict session-scoped AKK id only when the current list action prefills it. This preserves that exact native context and never follows the pane after a human switches threads. A rollout-backed Codex Session is a continuing context label but is not a direct ordinary-send target; use that terminal row's follow-current selector action instead. Discovery selectors, terminal ids, and turn ids are never session_id destinations."
    },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal-scoped send action. Codex terminal_user_explicit identifies one exact live physical terminal/process with a scanned, non-blocked approval state; Composer visibility, stability, exactness, and parsed working activity are not eligibility vetoes. Physical fallback sends C-u once to replace the current Composer, injects this request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto. Claude Code terminal_user_explicit remains exact-empty-only. Broken AKK state cannot veto the user; unmanaged delivery has no managed callback Turn, but AKK best-effort attaches an exact Terminal Watch callback before management release. Watch failure is reported without changing a successful Send. Once mutation begins, an uncertain result must not be retried automatically. Human discovery selectors are not structured-tool authority. Omit both target fields only when AKK should select the unique send-ready pane."
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

export const respondParameters = {
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

export const listParameters = {
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
  required: ["terminal_id"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id selected by the user, normally copied from the current terminal row. Watch is read-only: AKK prefers an exact task anchor and otherwise uses a warning-bearing best-effort terminal-activity fallback."
    },
    hardTimeoutMinutes: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "Optional maximum lifetime for observing this exact terminal."
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
        "Authoritative Terminal Watch id returned by watch or prefilled by list/status."
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
        "Exact full terminal_id from the selected terminal row's current available_actions. Do not use a short ref, session id, turn id, or constructed selector."
    }
  }
};

export const nativeInspectParameters = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_id", "inspection"],
  properties: {
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current native_inspect action. Never use a short ref, Session id, Turn id, or constructed selector. AKK refreshes and revalidates the binding internally."
    },
    inspection: {
      type: "string",
      enum: ["status"],
      description:
        "Closed adapter-owned inspection kind. Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1/0.150.1 and Claude Code 2.1.218/2.1.226/2.1.237/2.1.251 are regression-tested; another complete x.y.z version remains callable through the generic runtime profile with a compatibility warning. This is never an arbitrary native command string."
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
        "Exact full terminal_id from the current new_thread action. AKK refreshes and revalidates the lifecycle binding internally."
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
        "Complete native thread UUID from a resumable=true row returned for this exact terminal. Never truncate, guess, or select an unavailable row."
    }
  }
};

export const renewParameters = {
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

export const retryCallbackParameters = {
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
      deprecated: true,
      description:
        "Deprecated legacy Turn alias, or the exact raw-terminal selector prefilled by that terminal row's available status action. Managed Turn status must use turn_id; never construct or guess a raw-terminal selector."
    },
    watch_id: {
      type: "string",
      minLength: 1,
      description:
        "Authoritative Terminal Watch id prefilled by a current watch row. This inspects externally started work and is mutually exclusive with Turn targets."
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

export const cancelParameters = {
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

export const closeParameters = {
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

export const approveParameters = {
  type: "object",
  additionalProperties: false,
  not: { required: ["turn_id", "terminal_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["terminal_id"] }
  ],
  properties: {
    turn_id: {
      type: "string",
      description: "Authoritative AKK turn id containing the approval prompt."
    },
    terminal_id: {
      type: "string",
      minLength: 1,
      pattern: "^terminal:v[0-9]+:\\S+$",
      description:
        "Exact full terminal_id from the current terminal-scoped approval action. Managed Turn approval must use turn_id. AKK binds the user's reviewed prompt and revalidates terminal authority internally."
    }
  }
};

import { EXECUTOR_KINDS } from "./executors.js";

export const sendParameters = {
  type: "object",
  additionalProperties: false,
  required: ["request"],
  not: {
    anyOf: [
      { required: ["session_id", "selector"] },
      { required: ["session_id", "expected_terminal_token"] }
    ]
  },
  properties: {
    session_id: {
      type: "string",
      minLength: 1,
      description:
        "Strict session-scoped AKK id only when the current list action prefills it. This preserves that exact native context and never follows the pane after a human switches threads. A rollout-backed Codex Session is a continuing context label but is not a direct ordinary-send target; use that terminal row's selector/token action instead. Discovery selectors, terminal ids, and turn ids are never session_id destinations."
    },
    selector: {
      type: "string",
      minLength: 1,
      description:
        "Terminal-scoped selector: codex, claude, only, latest, an @short-ref, or a live terminal id. Use one only when explicitly named by the user or prefilled by list; never infer it. A follow-current handoff action uses the exact full terminal id together with expected_terminal_token. Legacy discovery selectors remain supported. Omit both target fields only when AKK should attach the unique eligible idle pane."
    },
    expected_terminal_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh terminal snapshot token prefilled by the same terminal row's follow-current send action. Preserve it exactly with that action's full terminal selector; never infer, copy, reuse, or combine it with session_id."
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
        "Closed adapter-owned inspection kind. Exact Codex 0.146.0/0.146.1/0.147.0/0.148.0 and Claude Code 2.1.218/2.1.226/2.1.237 /status profiles are supported; this is never an arbitrary native command string."
    },
    expected_binding_token: {
      type: "string",
      minLength: 1,
      description:
        "Fresh snapshot-bound terminal and binding token prefilled by this terminal's current native_inspect action. Never guess, construct, or reuse it after another terminal action."
    }
  }
};

export const newThreadParameters = {
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

export const reconcileBindingParameters = {
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

export const resumeThreadParameters = {
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
      { required: ["expected_message_id", "expected_transition_id"] },
      { required: ["expected_handoff_token", "conversation_id"] },
      { required: ["expected_handoff_token", "expected_message_id"] },
      { required: ["expected_handoff_token", "expected_transition_id"] }
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
    },
    expected_handoff_token: {
      type: "string",
      description:
        "Snapshot fence for the exact managed Turn close advertised only by terminals[].handoff_decision.choices.take_over_current.action. Copy that complete action only after explicit user confirmation; it requires turn_id and reason=superseded_by_human_context_switch, and cannot be combined with a raw-terminal target or another close fence."
    }
  }
};

export const approveParameters = {
  type: "object",
  additionalProperties: false,
  required: ["expected_approval_fingerprint"],
  not: { required: ["turn_id", "conversation_id"] },
  anyOf: [
    { required: ["turn_id"] },
    { required: ["conversation_id"] }
  ],
  allOf: [
    {
      if: { required: ["expected_terminal_token"] },
      then: { required: ["conversation_id"] }
    }
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
    },
    expected_terminal_token: {
      type: "string",
      description:
        "Only for a terminal-scoped manual Codex approval prefilled by the latest AKK list action. Preserve it exactly with that action's full conversation_id; never construct, reuse, or use it for automatic approval."
    }
  }
};

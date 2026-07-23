# Bidirectional Agent Protocol

This protocol supports managed bidirectional delegation through ACPX. tmux-controlled tasks reuse AKK conversation state and callback message types, but AKK sends the user-facing task directly to the existing pane and owns terminal monitoring.

- OpenClaw is the product manager, requirements owner, and final acceptance decision maker.
- Claude Code, Codex, or Cursor is the engineering implementation agent and can directly edit code.
- OpenClaw decides product direction, requirements interpretation, acceptance criteria, delivery scope, UX behavior, and acceptable compromises.
- The selected coding agent decides ordinary implementation details, but must ask OpenClaw before changing product behavior, narrowing scope, degrading quality, accepting a workaround, or changing delivery standards.
- Only messages requiring a response consume the response budget.
- Conversation storage is the durable source of truth for recovery, task listing, and future visualization.
- NDJSON event logs live at `~/.agent-knock-knock/conversations/<conversation-id>/events.ndjson` by default.

## Message

```json
{
  "id": "msg-...",
  "conversation_id": "task-...",
  "from": "openclaw",
  "to": "claude-code",
  "type": "task",
  "requires_response": true,
  "round": 1,
  "max_rounds": 50,
  "body": "Implement the requested change.",
  "metadata": {
    "workspace": "/path/to/project",
    "task_id": "task-...",
    "executor_kind": "claude",
    "executor_session": "bidirectional"
  }
}
```

Conversation state records the selected executor:

```json
{
  "conversation_id": "task-...",
  "openclaw_session": "agent:main:main",
  "executor": {
    "kind": "claude",
    "actor": "claude-code",
    "session": "bidirectional",
    "transport": "acpx"
  },
  "workspace": "/path/to/project",
  "status": "waiting_for_agent"
}
```

## Types

| Type | Requires response by default | Purpose |
| --- | --- | --- |
| `task` | yes | OpenClaw delegates work |
| `question` | yes | Coding agent asks OpenClaw to decide |
| `answer` | yes | OpenClaw answers or directs |
| `progress` | no | Coding agent reports progress |
| `blocked` | yes | Coding agent cannot continue |
| `done` | no | Coding agent reports completion |
| `error` | no | Tool, protocol, or runtime error |
| `control` | no | Budget warnings and lifecycle control |

## Routes

Messages must match the active `conversation_id`.

Allowed routes:

| Route | Allowed types |
| --- | --- |
| `openclaw -> claude-code` | `task`, `answer`, `control`, `error` |
| `claude-code -> openclaw` | `question`, `progress`, `blocked`, `done`, `error` |
| `openclaw -> codex` | `task`, `answer`, `control`, `error` |
| `codex -> openclaw` | `question`, `progress`, `blocked`, `done`, `error` |
| `openclaw -> cursor` | `task`, `answer`, `control`, `error` |
| `cursor -> openclaw` | `question`, `progress`, `blocked`, `done`, `error` |

## Budget

- `0-29`: normal collaboration
- `30`: OpenClaw asks the selected coding agent to converge
- `40`: OpenClaw warns the selected coding agent to finish, degrade, or fail within 10 response rounds
- `50`: soft stop unless OpenClaw explicitly extends
- `100`: hard stop

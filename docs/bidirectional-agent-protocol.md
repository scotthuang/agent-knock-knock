# Bidirectional Agent Protocol

This protocol supports managed bidirectional delegation:

- OpenClaw is the product manager, requirements owner, and final acceptance decision maker.
- Claude Code is the engineering implementation agent and can directly edit code.
- OpenClaw decides product direction, requirements interpretation, acceptance criteria, delivery scope, UX behavior, and acceptable compromises.
- Claude Code decides ordinary implementation details, but must ask OpenClaw before changing product behavior, narrowing scope, degrading quality, accepting a workaround, or changing delivery standards.
- Only messages requiring a response consume the response budget.
- Workspace conversation storage is the durable source of truth for recovery and future visualization.
- NDJSON event logs live at `.agent-knock-knock/conversations/<conversation-id>/events.ndjson`.

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
    "task_id": "task-..."
  }
}
```

## Types

| Type | Requires response by default | Purpose |
| --- | --- | --- |
| `task` | yes | OpenClaw delegates work |
| `question` | yes | Claude Code asks OpenClaw to decide |
| `answer` | yes | OpenClaw answers or directs |
| `progress` | no | Claude Code reports progress |
| `blocked` | yes | Claude Code cannot continue |
| `done` | no | Claude Code reports completion |
| `error` | no | Tool, protocol, or runtime error |
| `control` | no | Budget warnings and lifecycle control |

## Routes

Messages must match the active `conversation_id`.

Allowed routes:

| Route | Allowed types |
| --- | --- |
| `openclaw -> claude-code` | `task`, `answer`, `control`, `error` |
| `claude-code -> openclaw` | `question`, `progress`, `blocked`, `done`, `error` |

## Budget

- `0-29`: normal collaboration
- `30`: OpenClaw asks Claude Code to converge
- `40`: OpenClaw warns Claude Code to finish, degrade, or fail within 10 response rounds
- `50`: soft stop unless OpenClaw explicitly extends
- `100`: hard stop

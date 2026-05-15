# Bidirectional Agent Protocol

This protocol supports managed bidirectional delegation:

- OpenClaw is the manager and final decision maker.
- Claude Code is the developer and can directly edit code.
- Only messages requiring a response consume the response budget.
- NDJSON logs are the source for future visualization.

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

## Budget

- `0-29`: normal collaboration
- `30`: OpenClaw asks Claude Code to converge
- `40`: OpenClaw warns Claude Code to finish, degrade, or fail within 10 response rounds
- `50`: soft stop unless OpenClaw explicitly extends
- `100`: hard stop


# TODO

## Next Milestone: Real OpenClaw Integration

- Install or wire the generated skill template into `~/.openclaw/skills/bidirectional-chat/SKILL.md`.
- Replace Manager Claude simulation with real OpenClaw session delivery through `openclaw acp`.
- Verify that OpenClaw receives `question`, `blocked`, `progress`, and `done` messages.
- Verify that OpenClaw autonomously answers Claude Code questions without asking the user.

## Protocol Hardening

- Add parent message ids for threaded conversation reconstruction.

## Budget Management

- Add automatic `control` messages at 30 and 40 response rounds.
- Add default stop behavior at 50 response rounds.
- Add forced termination at 100 response rounds.
- Add tests for 30/40/50/100 budget behavior.

## Logging And Observability

- Add compact logs that omit duplicated raw prompt payloads.
- Redact tokens and sensitive local paths from logs where needed.
- Store final summaries separately from raw execution traces.
- Add a resume command that rebuilds OpenClaw context from a conversation directory.

## Developer Experience

- Improve README with complete setup and troubleshooting notes.
- Document when commands need sandbox/external permissions.

## Done

- Parse JSON returned by Claude Code into canonical protocol messages.
- Ensure `blocked` defaults to `requires_response=true`.
- Add a log viewer command that prints a readable conversation transcript.
- Add `npm run simulate:architecture`.
- Add `npm run simulate:weather`.
- Add `npm run transcript -- --log <log-path>`.
- Normalize raw `acpx` output into separate events:
  - `message`
  - `tool_call_started`
  - `tool_call_finished`
  - `permission_request`
  - `agent_status`
- Store conversation state under `<workspace>/.agent-knock-knock/conversations/<conversation-id>/`.
- Support transcript rendering from a conversation directory.
- Add validation for manager/developer role consistency and conversation routing.
- Add a callback driver that records Claude Code messages before delivering them to OpenClaw.

## Future UI

- Design a timeline view over NDJSON logs.
- Show message type, sender, round, and `requires_response` state.
- Show tool calls as expandable events.
- Show final delivery or failure reason at the top of a conversation.

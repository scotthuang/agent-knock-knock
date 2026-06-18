# TODO

## Next Milestone: Real OpenClaw Integration

- Run a fresh end-to-end OpenClaw delegate test after the latest callback delivery change:
  - OpenClaw calls `agent_knock_knock_delegate`.
  - Claude Code completes work and invokes the generated callback command.
  - `agent-knock-knock.callback` returns a `chat_send` delivery plan.
  - CLI follows with Gateway `chat.send` and `deliver: true`.
  - OpenClaw receives the callback as a visible session message, responds without polling logs/stdout/stderr, and sends the response through the original channel.
- Verify that OpenClaw receives `question`, `blocked`, `progress`, and `done` messages.
- Verify that OpenClaw autonomously answers Claude Code questions without asking the user.
- Diagnose and document the local OpenClaw `scheduleSessionTurn`/cron path failing on stale `node-host v2026.5.5` protocol mismatch.
- Decide whether to keep or remove `enqueueNextTurnInjection` now that `chat.send` is the active delivery path; current code keeps it as durable context.

## Current Handoff Notes

- Current callback delivery design:
  - The CLI records the Claude message into `~/.agent-knock-knock/conversations/<id>/events.ndjson`.
  - The CLI calls Gateway method `agent-knock-knock.callback`.
  - The plugin validates/enqueues durable context and returns `chat_send` params.
  - The CLI then calls Gateway `chat.send` with that structured callback payload and `deliver: true`.
- This avoids exposing Claude stdout/stderr to OpenClaw and avoids OpenClaw polling files/processes.
- Caveat found on 2026-05-17 with the previous `sessions.send` path:
  - The `sessions.send` leg is only a wake-up workaround.
  - OpenClaw persists that wake-up as a CLI-sender user message, so it can be interpreted as an injected/announce-like message rather than a normal conversational reply path.
  - A raw WebSocket probe showed trying to impersonate `openclaw-control-ui` from a non-UI client is rejected with `CONTROL_UI_ORIGIN_NOT_ALLOWED`; trying `gateway-client` backend without device identity is rejected with `DEVICE_IDENTITY_REQUIRED`.
- Manual verification succeeded on conversation `task-20260516T180554Z-d5226a92`:
  - CLI returned `delivery: "gateway_method+sessions_send"`.
  - Event log contains `callback_gateway_method_delivery` and `callback_session_send_delivery`.
  - OpenClaw session received the callback user message and replied to the `done` callback.
- Failed/abandoned path:
  - `scheduleSessionTurn` returned `scheduled: true` but did not surface in the webchat.
  - OpenClaw logs showed stale `node-host v2026.5.5` protocol mismatch against Gateway `2026.5.12`.
  - Calling `sessions.send` synchronously from inside the plugin handler deadlocked/timed out because it re-entered the Gateway from the Gateway process.
- Verification already run:
  - `node --check src/openclaw-plugin.js`
  - `node --check bin/agent-knock-knock.js`
  - `git diff --check`
  - `npm test` passes 35 tests.
- Worktree note:
  - `tmp/` is an untracked test artifact directory.
  - Current changes are not committed yet.

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
- Add callback idempotency/de-duplication for repeated Claude messages.
- Protect `events.ndjson` from appending to corrupted/non-NDJSON event logs.
- Add an OpenClaw plugin with a controlled `agent_knock_knock_delegate` tool that launches Claude Code in the background without returning raw Claude output.
- Add plugin-native callback delivery so Claude Code protocol messages flow back through OpenClaw without exposing stdout/stderr.
- Return async-pending delegate metadata that tells OpenClaw to yield instead of polling logs/processes.
- Deliver actionable callback messages into OpenClaw sessions through Gateway `chat.send` with external delivery enabled.
- Store conversations under `~/.agent-knock-knock/conversations` by default.
- Capture background Claude Code/acpx stdout and stderr to per-conversation `claude-output.log` for local diagnostics only.
- Add executor metadata so delegations can target Claude Code or Codex through ACPX.
- Add CLI task management commands: `list`, `status`, `send`, and `close`.
- Add OpenClaw plugin tools for task listing, status, follow-up sends, and local close.

## Future UI

- Design a timeline view over NDJSON logs.
- Show message type, sender, round, and `requires_response` state.
- Show tool calls as expandable events.
- Show final delivery or failure reason at the top of a conversation.

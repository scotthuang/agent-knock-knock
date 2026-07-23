# OpenClaw Session Turn Delivery

## Status

This is a historical design note. AKK now delivers structured coding-agent callbacks into the originating OpenClaw session without asking OpenClaw to poll agent logs, stdout, stderr, or process state.

The current managed-delegation flow is:

1. OpenClaw delegates a task through `agent_knock_knock_delegate`.
2. Codex, Claude Code, or Cursor works asynchronously through ACPX.
3. The coding agent invokes AKK's callback command with a canonical `progress`, `question`, `blocked`, `done`, or `error` message.
4. The CLI records the message, calls the plugin Gateway method `agent-knock-knock.callback`, and receives a validated `chat_send` delivery plan.
5. The CLI calls Gateway `chat.send` with external delivery enabled so OpenClaw can continue the original session.

For tmux-controlled sessions, AKK's terminal monitor owns callback delivery; the coding agent does not invoke the managed-delegation callback command.

## Historical Gap

The original OpenClaw interfaces did not provide one plugin-facing operation that both woke a session and represented an asynchronous external-agent result as a trusted conversational turn:

- `enqueueNextTurnInjection` persisted context but did not wake the session.
- `scheduleSessionTurn` had scheduled or announcement semantics.
- `sessions.send` woke the session but persisted CLI-sender metadata.
- Direct `chat.send` calls from an ordinary CLI client could not claim Control UI or trusted plugin provenance.

AKK addressed that gap with a plugin-owned Gateway method that validates and stages the callback before returning the narrowly scoped `chat.send` plan used by the CLI.

## Delivery Invariants

Callback delivery must:

1. Preserve the originating OpenClaw session and AKK conversation ID.
2. Trigger the target session's next run without impersonating a user interface.
3. Keep coding-agent stdout, stderr, terminal output, and thinking text out of the model-facing message.
4. Deduplicate retries with stable message and delivery identities.
5. Preserve structured provenance for audit and debugging.
6. Persist the canonical message before attempting external delivery.
7. Expose actionable callback failure and retry state without requiring raw-log inspection.

These invariants apply even if OpenClaw later exposes a more direct plugin session-turn API.

# OpenClaw Session Turn Delivery

## Status

AKK delivers structured terminal-monitor callbacks into the originating OpenClaw session without asking OpenClaw to poll terminal output, logs, or process state.

The current flow is:

1. OpenClaw sends a request to an authoritative AKK `session_id` through the plugin tool.
2. AKK creates a new `turn_id` and sends the user-facing request to the verified Codex or Claude Code tmux pane bound to that session.
3. AKK monitors the exact terminal, native session evidence, AKK session, Turn, process, and message.
4. When the adapter has reliable evidence, AKK records a canonical approval, completion, cancellation, stall, or error message.
5. AKK calls the plugin Gateway method `agent-knock-knock.callback` and receives a validated delivery plan.
6. AKK completes delivery into the originating OpenClaw session.

The identity chain is terminal → native coding-agent session → AKK `session_id` → `turn_id`. An ordinary send targets only `session_id` and creates a new Turn. Exact callbacks and managed control operations target `turn_id`. An unmanaged raw-terminal row may expose its own prefilled compatibility selector for status or recovery controls, but that selector is not a Turn ID and must never be constructed. If the coding agent asks a question, the callback marks that Turn `waiting_for_openclaw`; `respond(turn_id, answer)` continues the same Turn.

Native new/clear and resume controls operate between the terminal and Session layers. They require the exact `terminal_id` and a fresh compare-and-swap binding token; resume also requires one complete, verified historical native-thread UUID and that candidate row's opaque snapshot token. A successful transition creates or activates an AKK Session, advances the terminal binding generation, and creates no Turn. The next ordinary send creates the first Turn in that selected context.

The coding agent does not invoke a callback command. Terminal monitoring and callback delivery belong to AKK.

## Delivery Invariants

Callback delivery must:

1. Preserve the originating OpenClaw session, AKK `session_id`, and exact `turn_id`.
2. Trigger the target session's next run without impersonating a user interface.
3. Keep thinking text and unrelated raw terminal output out of callbacks, and disclose only the approval details required for review. Claude approval callbacks omit raw commands.
4. Deduplicate retries with stable Turn, message, and delivery identities.
5. Preserve structured provenance for audit and debugging.
6. Persist the canonical message before attempting external delivery.
7. Expose actionable callback failure and retry state without requiring raw-log inspection.
8. Refuse to report completion when terminal evidence is stale, ambiguous, or unsupported.
9. Fence every callback to the terminal incarnation, native identity, Session, Turn, and binding generation that created it, so a pre-transition callback cannot mutate the active post-transition context.

These invariants apply even if OpenClaw later exposes a more direct plugin session-turn API.

Native clear/new/resume operations are outside callback delivery and ordinary Turn creation. They are serialized against monitors and callback/recovery mutations; unresolved work blocks the transition, and stale delivery remains attached only to its historical Turn.

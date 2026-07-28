# OpenClaw Session Turn Delivery

## Status

AKK delivers structured terminal-monitor callbacks into the originating OpenClaw session without asking OpenClaw to poll terminal output, logs, or process state.

The current flow is:

1. OpenClaw delegates a task through an AKK plugin tool.
2. AKK sends the user-facing task to a verified Codex or Claude Code tmux pane.
3. AKK monitors the exact pane, process, conversation, and message.
4. When the adapter has reliable evidence, AKK records a canonical approval, completion, cancellation, stall, or error message.
5. AKK calls the plugin Gateway method `agent-knock-knock.callback` and receives a validated delivery plan.
6. AKK completes delivery into the originating OpenClaw session.

The coding agent does not invoke a callback command. Terminal monitoring and callback delivery belong to AKK.

## Delivery Invariants

Callback delivery must:

1. Preserve the originating OpenClaw session and AKK conversation ID.
2. Trigger the target session's next run without impersonating a user interface.
3. Keep thinking text and unrelated raw terminal output out of callbacks, and disclose only the approval details required for review. Claude approval callbacks omit raw commands.
4. Deduplicate retries with stable message and delivery identities.
5. Preserve structured provenance for audit and debugging.
6. Persist the canonical message before attempting external delivery.
7. Expose actionable callback failure and retry state without requiring raw-log inspection.
8. Refuse to report completion when terminal evidence is stale, ambiguous, or unsupported.

These invariants apply even if OpenClaw later exposes a more direct plugin session-turn API.

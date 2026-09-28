# Codex CLI 0.158.0 compatibility

This adapter targets the installed `codex-cli 0.158.0` and official
[`rust-v0.158.0`](https://github.com/openai/codex/tree/rust-v0.158.0), commit
`064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`. It uses the native app-server
protocol and the observed fullscreen TUI. It does not require changing Codex's
history format or disabling its shared background server.

| User flow | Behavior |
| --- | --- |
| Ordinary AKK Send to a physical Codex terminal | Captures the foreground thread before Send and attaches an exact task Watch when the controller supplies a callback route |
| Completion after a watched terminal exits | Reads the bound task's durable completion and retries the callback outbox independently of terminal availability |
| Watch an already running task from its main Composer | Uses a fresh native `/status` and the exact active turn; an unrelated later task cannot take over the Watch |
| Blocking native questions after an exact Watch attaches | Replays the exact pending request, collects the current user's answers, and submits one native response |
| Async questions after an exact Watch attaches | Maps the native per-question identity, answers only the expected active turn, and verifies a durable reply receipt |
| Native status and typed model selection | Uses the observed 0.158 fullscreen Composer, command popup, and model/effort menus |
| Explicit terminal-activity Watch | Remains best effort; its receipt does not promise exact task completion or automated answers |

## Task identity and callbacks

The fresh, closed `/status` transaction binds one physical process incarnation to its
foreground native thread. A previous card, matching working directory, newest
history file, or the shared server's list of threads cannot establish this
binding. On the local background server, Codex drains the new status history cell before
its next draw; AKK requires the restored styled empty Composer and complete
newest card after the verified command submission. This works even when
fullscreen clipping keeps the number of visible cards unchanged. Embedded and
remote server modes do not inherit this proof. AKK checks the server's own
version and Codex home before reading
`thread/read`, `thread/turns/list`, and `thread/items/list`.

A Send captures the prior latest turn before terminal input. It recognizes the
native user text with Codex's newline and trimming rules, requires one exact
acceptance, and persists that turn identity. Completion is read through this
boundary even when a later turn exists. Repeated sweeps use the existing durable
callback outbox and delivery identity. A temporary read or callback failure does
not authorize sending the user request again.

Completion text includes native Plan-mode output as well as final agent messages.
A completed planning task therefore returns its plan body in the callback.

Physical tmux Send uses native bracketed paste for this exact Codex version,
including single-line requests. Codex consumes the complete paste as one event
and clears its character-burst Enter suppression before the one submission key.
The terminal transport acknowledging a stream of literal keys does not prove
that Codex has consumed that stream. Herdr retains its native text transport.

## Questions and answer receipts

Blocking `request_user_input` prompts are native server requests rather than
ordinary paginated display items. A scoped connection replays only the bound
active turn's pending requests and releases its own subscription afterward.
Partial multi-question answers remain in the private Watch checkpoint; only the
complete native answer map is sent. Secret questions remain manual. The exact
native call output in the paginated record proves which answer was accepted;
a generic request-resolved event is insufficient.

Async replies use the native tuple
`["request_user_input_async", itemId, questionIndex]`. AKK rechecks the exact
pending question and uses `turn/steer` with `expectedTurnId`. Codex rejects a
completed or replaced turn before accepting input. This path cannot start a new
task. Confirmation requires the unique client message ID, exact native reply
envelope, and answered-question identity in durable history. Selecting Other
opens the native text editor; submitting its text follows the same receipt
checks. Queuing an answer into a future turn is not offered for this adapter.

Both response paths reserve the existing one-shot interaction receipt before
submission. If delivery cannot be confirmed, the public state is uncertain and
automatic replay is blocked. A different competing answer is never reported as successful delivery of
the requested answer. The blocking protocol has no client response ID: an
identical answer accepted concurrently from the native TUI proves the requested
answer, but cannot identify which client won. Completed native turns clear expired async questions
so historical prompts cannot prevent the final callback indefinitely.

Before the async response's foreground check, a private styled capture proves the
empty Composer; ordinary text captures cannot establish that proof. Identity,
question, and Composer checks surround that capture so a draft or changed surface
cannot authorize navigation or an answer.

## Remaining boundaries

A first Watch requested while a blocking modal already owns the terminal cannot
safely run `/status`. Without an existing exact binding, this falls back to an
activity Watch with manual question handling. Send followed by a question already
has the binding and uses the exact response path above.

Paginated task Watches are separate from legacy managed Sessions/Turns. Managed
session-only dispatch and legacy native thread new/resume are not established by
this adapter. Do not infer those capabilities from a successful TUI profile or
claim an activity Watch proves an exact task. Older 0.157.x clients retain their
[documented limitations](codex-0.157.1-compatibility.md).

Store writer protocol 8 protects the new anchors and private multi-question
checkpoints from older writers. Existing records remain readable; upgrading an
active store uses the existing exclusive writer upgrade procedure.

## Validation

Fast fixtures cover paginated read boundaries, identity changes, text acceptance,
terminal exit and callback replay, expired and competing answers, native question
batching, durable answer receipts, and fullscreen UI profiles. Real native
validation and release-gate results are recorded with the release evidence.

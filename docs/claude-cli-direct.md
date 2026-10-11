# Claude Code direct control

AKK **0.14.3** adds basic control of an already-open Claude Code CLI without tmux or Herdr. No Claude plugin, hook, special launch argument, replacement agent, or restart is required.

The initial live-tested combination is **Claude Code `2.1.296` on macOS**, using native peer protocol `1`. This is a tested version, not a claimed minimum or a promise that every newer version works. Discovery checks the running CLI's registry, native session UUID, PID/start time, and socket identity. A compatible runtime contract is required; unknown identity or protocol is not guessed.

AKK uses a small **Python 3 helper on the controller side** to verify macOS Unix-socket peer credentials. Python 3 must be available to AKK. This is not installed into Claude Code and does not change its login, proxy, permissions, or settings. Other operating systems do not yet have this direct adapter; existing supported terminal routes remain available.

## What works

| Capability | Direct connection |
| --- | --- |
| Discover and select an existing CLI | Exact native session and process identity; separate sessions in the same directory remain separate |
| Send a task | Allowed when the selected CLI is verified idle; Send creates its own durable Watch |
| Status | Native activity plus bounded public text and tool-action summaries from the exact input's local transcript |
| Watch an existing task | Requires a verified, currently active root input; no prompt insertion |
| Completion and exit observation | Parent-chain and tool-result evidence; an idle state alone is not success |
| Recovery | Inspect/reconcile an existing Watch, explicitly renew it, stop observation, close Send management, and retry a known retryable callback |
| Approvals and blocking questions | Registry waiting hints only; no direct approval or answer submission, and no promise of comprehensive interaction notifications |
| Models, permissions, cancellation, new/clear/resume | Unavailable through this direct connection |

For an unsupported operation, return to the original Claude Code terminal. If that same session also has an eligible tmux/Herdr connection, AKK can route an already-supported special operation through its terminal adapter. This does not add terminal capabilities for unreviewed versions or unsupported dialogs. Core operations still prefer the direct connection.

The terminal and direct paths must agree on the native UUID, PID and process start; matching a directory or a title is insufficient. Busy, blocked, refused, or uncertain sends do not trigger a second send through a terminal.

## Use it

Keep the authenticated Claude Code CLI open and ask your controller to refresh `agent_knock_knock_list`. Select its exact conversation ID from the returned actions. A task request can be as simple as:

> Use AKK to ask Claude Code in my-project to inspect the failing tests. Tell me when it finishes.

Save the `watch_id` returned by Send. It already identifies the completion monitor; do not add another Watch for that task. Use Status on the conversation for its latest input, or on the Watch for its exact saved input. For a task started manually in the CLI, explicitly ask the controller to Watch it.

The usual `CLAUDE_CONFIG_DIR` is respected. AKK does not modify Claude's inbound-message policy: if the session holds or refuses peer messages, the result remains held/refused rather than being bypassed with terminal input. Busy Send is rejected because Claude can absorb an inbound message into the task already running.

## Read the result correctly

- `delivered` and `agent_acceptance: proven` require the submitted input UUID, peer message ID and actual sender PID in the native transcript. A successful socket write alone does not prove acceptance.
- `native_thread_id` is the Claude session UUID. `native_input_id` identifies a user input, with `task_anchor_kind: native_input_uuid`; it is not a fabricated native turn ID.
- `completed`, `interrupted`, `failed`, and `exited` are different outcomes. Completion means the exact native task finished, not that its requested objective or every tool call succeeded. If the original process exits, a later process resuming the same history is not substituted.
- A registry permission/input wait can be shown as a manual-action hint. Requests have not been exhaustively scanned: `pending_interaction_count: null` means unknown, not zero.
- `callback_expected` describes pending/future controller delivery. It normally becomes false after the completed callback has been accepted. Controller acceptance does not prove delivery to a downstream chat channel.

Status limits its public progress body to **800 Unicode code points**, after redaction and at complete grapheme boundaries. It excludes hidden reasoning, raw long tool output, full arguments and diffs. The final public result is also bounded and reports truncation. `read_at` is the read time; `latest_item_at` comes from a native record or is null. List does not include progress or final-result bodies.

Reads are bounded to the most recent 16 MiB of the exact session transcript. A missing old anchor, conflicting parent chain, replaced transcript, unsupported asynchronous/background work, or unavailable native record produces an explicit unknown/read error. AKK does not borrow a later task's result or treat idle as completion. Resumed histories can contain old record replays; only the selected input's proven causal chain is used.

## Monitoring and recovery

Send and explicit Watch share the **720-minute default hard deadline**, with a two-second observation interval. The deadline is separate from a terminal-managed task's 60-minute inactivity window. Expiration stops that observation; it does not cancel Claude's task or silently create another Watch.

Use an explicit renewal on the existing Watch only when the same native input is still active. A completed, failed, interrupted, or exited task cannot renew. `recover` reconciles saved state; it neither resends the prompt nor extends the deadline. `close` ends AKK's management of a Send, while `unwatch` stops observation. Neither cancels Claude. Callback retry is restricted to a known retryable delivery failure; accepted or uncertain notifications are not blindly replayed. See [Backend Recovery](backend-task-recovery.md) for the shared concepts.

AKK persists the exact acceptance anchor, monitor deadline and callback outbox. It polls the native records instead of relying on Claude's session-level idle notification, whose subscriptions can replace one another and which does not identify an independently completed task.

## Protocol and verification boundary

This adapter uses Claude's local agent registry, Unix-domain inbox and native transcript. The complete peer wire format and transcript schema are version-sensitive implementation details, not a guarantee of a permanently stable public API. AKK checks the contract and fails closed on unverifiable identities and task outcomes; it does not attach to a new SDK/headless process and call that control of the original CLI.

The isolated research and implementation checks cover native discovery, exact sender/input acceptance, public result observation, same-directory separation, rejected busy sends and uncertain outcomes. Synthetic regressions additionally cover transcript replay/compaction history, identity conflicts, late receipt races, task isolation, callback deduplication and recovery. Broader operating-system support and all native interaction/control APIs remain outside this first direct adapter.

# Claude Code control

AKK controls an already-open Claude Code CLI through its native connection or an exact supported terminal. Standard `claude` and wrappers such as `tclaude` use the same adapter; `tclaude` is an executable/configuration choice, not a prerequisite. The default executable is `claude`, with the usual `~/.claude` configuration home unless configured otherwise. Native control needs no tmux/Herdr, Claude plugin, hook, special launch argument, replacement agent, or restart.

Starting with AKK **0.15.0**, new Claude Code sends automatically prefer a **managed terminal Turn** when AKK verifies a unique controllable tmux/Herdr counterpart for the exact native session and process. The result supplies a `turn_id` for monitoring and supported approvals or question responses; the caller does not select a transport or enable background management. Without that exact terminal, AKK uses the native inbox and returns a `claude-cli-watch:...` receipt. Codex CLI continues to prefer its shared backend. Existing Turns, Watches and send receipts retain their original provider and are never migrated or resent to adopt this policy.

An explicitly selected physical terminal is a separate existing operation. When List offers that terminal's `terminal_user_explicit` Send, call Send with its exact displayed `terminal_id` and request. AKK may enter text and submit Enter even when native conversation identity is unresolved, subject to the current terminal input-safety checks: an empty recognized main Composer, a known native footer, and no running or unproven foreground turn. Background shells alone do not block this physical Send. This does not prove native acceptance or completion and does not add background-worker protocol support. Ordinary managed sends never silently downgrade to physical input after failure, and callers do not pass a new scope or private token.

Live observations include **Claude Code `2.1.295` and `2.1.296` on macOS**, using native peer protocol `1`. These are tested versions, not minimum versions or a promise that every UI variant works. An unlisted, complete `x.y.z` version can use the compatible runtime contracts; absence from the regression matrix alone does not disable an otherwise eligible operation. Discovery checks the running CLI's registry, native session UUID, PID/start time, and socket identity. Unknown identity, protocol or UI structure is not guessed.

AKK uses a small **Python 3 helper on the controller side** to verify macOS Unix-socket peer credentials. Python 3 must be available to AKK. This is not installed into Claude Code and does not change its login, proxy, permissions, or settings. Other operating systems do not yet have this direct adapter; existing supported terminal routes remain available.

## Native connection capabilities

This table describes the native fallback when no exact controllable terminal is available. A managed terminal Send uses the existing managed-Turn contracts described below.

| Capability | Direct connection |
| --- | --- |
| Discover and select an existing CLI | Exact native session and process identity; separate sessions in the same directory remain separate |
| Send a task | Allowed when the selected CLI is verified idle; Send creates its own durable Watch |
| Status | Native activity plus bounded public text and tool-action summaries from the exact input's local transcript |
| Watch an existing task | Requires a verified, currently active root input; no prompt insertion |
| Completion and exit observation | Parent-chain and tool-result evidence, including successful Stop hook summaries; an idle state or hook summary alone is not success |
| Recovery | Inspect/reconcile an existing Watch, explicitly renew it, stop observation, close Send management, and retry a known retryable callback |
| Approvals and blocking questions | An exact native Watch sends deduplicated notifications for its task's registry waiting-state changes; hints are notify-only (`requires_response=false`, `actionable=false`), with no direct approval or answer submission |
| Models, permissions, cancellation, new/clear/resume | Unavailable through this direct connection |

If that same session has exactly one eligible tmux/Herdr connection, new Sends use its managed path, and the conversation's public `capabilities` and `available_actions` also expose supported cancellation, native inspection, model and thread lifecycle operations. These fields follow the adapter's runtime evidence, state and action eligibility. AKK revalidates the exact terminal counterpart before execution. Conversation reads and standalone Watches may still use the native connection; task operations follow the original `turn_id` or `watch_id`. An unverified version can attempt a supported runtime contract, but unsupported dialogs require manual handling in the original terminal.

Claude approval support follows the managed `turn_id` with fresh approval evidence. On an approval callback, refresh that Turn's Status and use its advertised approval action for the authorized decision. New managed terminal sends create this task ownership automatically. A native peer Send creates a native Watch, which cannot inherit managed approval authority; its waiting notifications remain notify-only. Current terminal-managed questionnaires can advertise `respond_interaction` through the associated conversation, with the original Turn target and a required fresh Status before answering. Unlisted complete Claude versions may use the existing questionnaire parser when the full question, choices and footer match its supported structure. The response remains bound to the actual version, original Turn, current prompt and single-use offer; unknown or malformed dialogs, secret questions and multi-select questions remain manual. This does not claim live questionnaire verification on every version. AKK's current Claude native peer adapter does not implement question responses, and neither Claude route implements permission-mode switching. `set_permissions` and `permission_options` are not enabled merely because the terminal adapter detects approval prompts. The sender permission declaration below is separate from changing the receiver's permission mode.

The terminal and direct paths must agree on the native UUID, PID and process start; matching a directory or a title is insufficient. An exact terminal that is busy, blocked, has conflicting ownership or an unavailable Store returns that blocker; AKK does not bypass it through native delivery. Identity conflicts and refused or uncertain sends likewise do not authorize switching connections. A previously selected task route remains fixed even if another connection later becomes available.

Claude terminal model control has regression profiles for `2.1.266` and `2.1.285`; other complete `x.y.z` versions may attempt the same runtime contract through a profile bound to their actual version. List's `model_control.reason` identifies that unverified profile. Catalog discovery must recognize the live picker, choices and session-scope footer before selection becomes available. Model changes still require an empty idle Composer, exact session/process identity, a fresh catalog and a verified postcondition, and affect only the current session. Missing or malformed versions and unsupported picker layouts remain unavailable. A supported new-thread transition also supports Clear; Resume requires an eligible exact UUID from a fresh resumable-thread catalog. Cancellation support follows the exact terminal adapter and transport, while each currently offered action remains subject to runtime state checks.

## Use it

Keep the authenticated Claude Code CLI open and ask your controller to refresh `agent_knock_knock_list`. Select its exact conversation ID from the returned actions. A task request can be as simple as:

> Use AKK to ask Claude Code in my-project to inspect the failing tests. Tell me when it finishes.

For managed or native inbox delivery, save the task identity returned by Send: `turn_id` for managed terminal delivery, or `watch_id` for native inbox delivery. Monitoring starts automatically; do not add another Watch for that task. Use Status with that exact task identity for follow-up, including managed approvals. An explicitly selected physical Send reports its actual dispatch and observation evidence; without native identity, it cannot promise acceptance or completion monitoring. Conversation Status reads the latest input and must not replace the original task identity. For a task started manually in the CLI, explicitly ask the controller to Watch it.

The usual `CLAUDE_CONFIG_DIR` is respected. For native inbox delivery, AKK does not modify Claude's inbound-message policy: if the session holds or refuses peer messages, the result remains held/refused rather than being bypassed with terminal input. Native busy Send is rejected because Claude can absorb an inbound message into the task already running.

### When List offers different operations

List's per-conversation guidance explains the current usable operations and
recovery steps. An idle native conversation can accept Send without offering
Watch because there is no active task to observe. Send creates monitoring for
its own task. A working or waiting native conversation can offer Watch, whose
creation still requires an exact active input. Terminal activity observation is
a different, best-effort operation and may remain available on an unidentified
terminal.

If a Claude pane lacks verified identity, List requests one additional fresh
snapshot from the configured reader, shared across unresolved Claude panes in
that scan. It applies the same interactive-session and exact process, registry
and configuration-home checks. It never types into the terminal, promotes a
background agent, or substitutes a same-directory conversation. If the retry
cannot establish native identity, the row explains the missing proof and the
operations still offered, even when a more specific diagnostic is unavailable.
An independently offered physical Send may still accept terminal input. Follow the
actual action and its stated proof limits rather than interpreting missing
native identity as a blanket input prohibition.

The live investigation initially looked like a reader omission. The installed
Claude Code 2.1.295 runtime instead deliberately excludes a foreground registry
record carrying `parkedJobId` from `agents --json`; `--all` only adds completed
background jobs and does not remove that exclusion. A foreground window in the
Agents/background-session interface can display a conversation executed by a
separate `bg-spare` process. Its own registered session is therefore not proof
of the identity of the displayed conversation. This finding describes the
inspected installation, not a universal contract for every Claude release.

For an unresolved Claude terminal, AKK can explain this state using a bounded,
read-only check of the foreground process's owned registry, exact PID and live
process start identity. Positive evidence produces background-view guidance.
When that physical terminal offers Send, explicitly selecting it can enter text
and submit Enter; the result must still be checked in the window because native
acceptance and exact task completion are unproven. When Send is not offered,
continue manually in the current window, or start an ordinary foreground
conversation without attaching a background conversation, then refresh List.
Restarting and reopening the same background conversation does not change its
execution model. This is a display diagnosis only: AKK does not resolve the
background job or worker, access daemon or claim sockets, add a background
protocol delivery route, or promise exact background-task completion. The
background-view marker neither grants physical Send authority nor blocks an
otherwise valid physical input action.

Missing, unsafe, malformed, stale or unreadable evidence does not become a
background diagnosis. List retains the generic explanation that the current
conversation identity could not be confirmed, with the physical input option
when actually offered, or steps to inspect the pane, continue directly, and
retry ordinary startup/List refresh where appropriate.
Restarting remains an attempt, not a guaranteed repair. Background jobs remain
excluded from AKK's interactive conversation list, so scan counts are not a
count of every Claude process on the machine.

### Sender permission class

For native inbox delivery, set `AKK_NATIVE_CLAUDE_SENDER_PERMISSION_CLASS` in the **AKK/controller Host's launch environment**, with `bypass` or `prompting`. AKK declares that value in the native `<cross-session-message from-mode="…">` envelope and escapes the supplied task text. Callers pass the plain task request; they do not construct the envelope. Managed terminal sends do not use this envelope. The declaration does not change the target's permissions or bypass its hold/refuse policy.

This value describes the sender/controller's actual permission policy, as explicitly configured by its operator. Within an authorized setup task, use that policy or verified evidence about the sender to select the class. The target's process flags and permission mode can help diagnose why it held a message, but cannot establish the sender's class. Do not copy the receiver's mode or infer `bypass` from a headless controller. If the sender's policy cannot be established, leave the declaration unset. AKK itself consumes only the explicit sender configuration.

Setting the variable only in Claude/tclaude or another shell does not update an already-running controller Host. Unset or empty means no declaration; an invalid value rejects a new Send before submission. Receipts expose `sender_permission_class` and `sender_permission_class_source` (`operator_configured` or `unspecified`), which are configuration diagnostics, not proof of acceptance. Changing the variable does not alter or resend a previously held or uncertain message. Inspect its original Watch and return to the original terminal when manual review is required; do not replay it automatically.

## Read native results correctly

- `delivered` and `agent_acceptance: proven` require the submitted input UUID, peer message ID and actual sender PID in the native transcript. A successful socket write alone does not prove acceptance.
- `native_thread_id` is the Claude session UUID. `native_input_id` identifies a user input, with `task_anchor_kind: native_input_uuid`; it is not a fabricated native turn ID.
- `completed`, `interrupted`, `failed`, and `exited` are different outcomes. Completion means the exact native task finished, not that its requested objective or every tool call succeeded. If the original process exits, a later process resuming the same history is not substituted.
- A successful `stop_hook_summary` allows completion when the exact input's final message and durable completion record agree. Nonempty `hookErrors` or `preventedContinuation=true` remain unsafe, leaving completion unproven. A hook summary alone does not settle a task.
- A registry permission/input wait can be shown as a manual-action hint. Requests have not been exhaustively scanned: `pending_interaction_count: null` means unknown, not zero.
- `callback_expected` describes pending/future controller delivery. It normally becomes false after the completed callback has been accepted. Controller acceptance does not prove delivery to a downstream chat channel.

Status limits its public progress body to **800 Unicode code points**, after redaction and at complete grapheme boundaries. It excludes hidden reasoning, raw long tool output, full arguments and diffs. The final public result is also bounded and reports truncation. `read_at` is the read time; `latest_item_at` comes from a native record or is null. List does not include progress or final-result bodies.

Reads are bounded to the most recent 16 MiB of the exact session transcript. A missing old anchor, conflicting parent chain, replaced transcript, unsupported asynchronous/background work, or unavailable native record produces an explicit unknown/read error. AKK does not borrow a later task's result or treat idle as completion. Resumed histories can contain old record replays; only the selected input's proven causal chain is used.

## Monitoring and recovery

Native Send and explicit native Watch share the **720-minute default hard deadline**, with a two-second observation interval. Managed terminal tasks use their existing Turn monitor and separate 60-minute inactivity window. Keep the original task's advertised recovery actions. Native Watch expiration stops that observation; it does not cancel Claude's task or silently create another Watch.

For a native Watch, use an explicit renewal only when the same native input is still active. A completed, failed, interrupted, or exited native task cannot renew. `recover` reconciles saved state; it neither resends the prompt nor extends the deadline. `close` ends AKK's management of a native Send, while `unwatch` stops observation. Neither cancels Claude. Managed terminal tasks retain their existing Turn-specific approval, renewal, cancellation and close actions. Callback retry is restricted to a known retryable delivery failure; accepted or uncertain notifications are not blindly replayed. See [Backend Recovery](backend-task-recovery.md) for the native concepts.

If the native conversation's exact terminal is owned by another AKK Store, idle
Claude does not authorize a managed Send or native fallback. Use only its fresh
`transfer_store_authority` action when offered: the tool is
`agent_knock_knock_reconcile_binding` with `operation:"transfer_store_authority"`
and the action's physical `terminal_id`. This explicitly transfers settled Store
authority without sending Claude input or creating a Turn. Legacy records may
require the user to stop all source-Store Hosts and old writers and explicitly
set `maintenance_acknowledgement:true`; the agent cannot infer that condition.
Afterward refresh List and keep the original native `conversation_id` for Send.
Ordinary binding reconciliation only detaches a local Session and cannot replace
this transfer. See [terminal recovery](operator-guide.md#terminal-recovery-and-diagnostics).

AKK persists the exact acceptance anchor, monitor deadline and callback outbox. It polls the native records instead of relying on Claude's session-level idle notification, whose subscriptions can replace one another and which does not identify an independently completed task.

## Protocol and verification boundary

This adapter uses Claude's local agent registry, Unix-domain inbox and native transcript. The complete peer wire format and transcript schema are version-sensitive implementation details, not a guarantee of a permanently stable public API. AKK checks the contract and fails closed on unverifiable identities and task outcomes; it does not attach to a new SDK/headless process and call that control of the original CLI.

Transcript and Status readers validate supported record and panel structures instead of requiring a tested version floor. A transcript task still needs a consistent complete version and exact causal identity; mixed versions within its chain do not prove completion. Recognized Status diagnostics are bounded and parsed as data, including supported Auto mode fields; a new version number does not make an unknown panel safe.

The isolated research and implementation checks cover native discovery, exact sender/input acceptance, public result observation, same-directory separation, rejected busy sends and uncertain outcomes. Synthetic regressions additionally cover transcript replay/compaction history, identity conflicts, late receipt races, task isolation, callback deduplication and recovery. Broader operating-system support and all native interaction/control APIs remain outside this first direct adapter.

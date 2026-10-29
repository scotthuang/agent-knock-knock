# Conversations and Watch inventory

Since 0.14.13, discovery is separate from monitoring. `agent_knock_knock_list`,
`/akk list` and CLI `list` return currently discoverable conversations. They do
not include Watch inventories or retained managed Turn history. Current managed
ownership, pending approvals and blocking conditions remain on the conversation.
Desktop sidebar entries whose live owner is unconfirmed remain visible with
their actual connection status; visibility does not authorize Send.

Use `agent_knock_knock_watches`, `/akk watches` or CLI `watches` to inspect
monitoring. This is a read-only Store query: it does not create or renew a Watch,
reconcile callbacks, reconnect a native session or send notifications.

## Understanding a conversation row

Each conversation includes `usage`, a bounded explanation derived from its
current offered actions, activity, capabilities and blockers:

| Field | Meaning |
| --- | --- |
| `summary` | Whether the conversation can receive work or currently needs attention |
| `available` | What the user can do now |
| `limitations` | Why a relevant operation is unavailable, including uncertainty |
| `next_steps` | Concrete actions the user or controller can take next |

Controllers should present this guidance in the user's language, beside the
conversation title and project. A list of missing switches or internal reason
codes is not a substitute for explaining what to do. Guidance is regenerated
from each observation; it does not grant authority, add an action, or change
existing action eligibility. The current `available_actions` and their input
contracts remain authoritative. `usage` is an additive field within Host List
projection v4. Action contract v35 adds a no-existing-stash prerequisite to Claude physical Send. This narrows eligibility for an empty input box with a stashed draft, so the action contract increases from v34; it is not only a wording change. The per-agent Composer policy names and public Send parameters remain unchanged. Readiness diagnostics are additive, and compact projection remains v4.
The shared List projection adds this guidance to Codex CLI, Codex Desktop,
Claude and terminal-only rows. Existing identities, capabilities and action
offers retain their meanings; consumers may ignore the new display field.
The additional identity recheck and background-view diagnosis described below
apply only to Claude terminals, not to Codex discovery or dispatch.

Different rows can legitimately offer different next steps. An idle native
Claude conversation may accept Send without offering Watch: there is no active
task to attach that Watch to. Send starts monitoring for its new task, so keep
the returned Turn or Watch identity. A working native conversation can offer
Watch, with the exact active input revalidated when observation starts. A
terminal-only Watch can observe terminal activity; it does not establish an
exact native task or prove that task succeeded.

For Claude, an idle screen does not by itself authorize managed Send or New
thread. Each action offer uses that operation's current reader identity
and idle checks from execution; managed Send additionally checks that a safe
transcript boundary can be captured. A missing, busy or mismatched reader row,
or an unsafe transcript boundary, removes the affected managed action and
provides a recovery explanation. The independent physical Send action retains
its own input checks. No managed operation silently falls back to physical
input. `managed_send_readiness` and `thread_lifecycle_readiness` report the
affected check and next steps without exposing private transcript anchors.
Execution obtains fresh evidence again, because state can change after the
list observation.

A resumed Claude thread may retain its UUID while running in a new process.
New thread can safely reattach an existing Session belonging to a conclusively
inactive process before starting its transition. This preserves history and
increments the binding generation; it does not ignore native-thread claims or
relax Store authority. List remains read-only, and unknown process ownership
or unresolved work still prevents automatic reattachment.

For an unresolved Claude terminal identity, List makes one additional fresh
reader check, shared across the unresolved Claude terminals in that scan. It
does not send terminal input or trust a registry file alone. If native identity
remains unproven, List retains that uncertainty and explains the currently
offered operations. A separately verified physical terminal Send can remain
available; a failed native identity check does not establish native acceptance
or completion, and does not by itself prove that terminal input is unsafe.

A Claude window can display a background conversation while its own foreground
conversation is parked. When a read-only check of that foreground process's
owned registry and current process incarnation verifies this state, guidance
explains that this window is in the background-session interface. This does not
make the window read-only. When its real `terminal_user_explicit` Send action
is offered, explicitly selecting that physical terminal lets AKK enter the
requested text and submit Enter. The guidance distinguishes input dispatch
from unproven native acceptance and completion, and asks the user to inspect
the execution result in the window. Without that physical action, the user can
continue manually or start an ordinary foreground conversation and refresh
List. Reopening the same background conversation does not make it an ordinary
foreground conversation.
The raw observation adds
`native_agent_identity_observation.window_role: "background_view"` only for
that positive diagnosis; compact Host output carries its explanation in `usage`.
This diagnosis does not identify or bind the background worker, inspect daemon
or claim sockets, or grant physical Send authority or exact-task monitoring.
Physical authority comes only from the current terminal action and its input
safety checks, not from the background-view marker.

If the registry check is missing, malformed, unsafe, stale or unavailable, List
does not infer a background session. It retains the generic explanation that
the native conversation identity could not be confirmed, together with the
actual physical Send option when offered, or instructions to inspect the pane,
use it manually, and retry ordinary startup and List refresh if appropriate.
Failure to diagnose never removes the guidance.
Relaunching is a recovery attempt, not a guaranteed repair.

Claude physical rows additionally expose `physical_send_readiness` from the
same current screen evidence used before input. An unsent user draft blocks
Send and tells the user to send, save or clear it manually. A running foreground
turn blocks Send until completion; an unproven running state asks the user to
wait and refresh. Background shells alone do not block Send when the main
Composer is empty and foreground completion can be verified. Unknown footer
controls or an unrecognized input box stop automatic input and explain what
AKK could not verify. These explanations take precedence over native-identity
uncertainty. Codex readiness and managed Send rules are unchanged.

List defaults to discovery plus current native activity. It defers per-window
approval, Composer and transcript-boundary checks to Status and execution
preflight; rows identify this with `detail_scan: "deferred"`. A native Send
offer with `send_preflight_required: true` is callable but is not a cached grant
of terminal-input authority. Send still checks the selected live process,
ownership, transcript boundary and input surface before writing text. Missing
terminal controls in this mode mean unscanned, not unsupported.

Missing screen evidence is separate from an unsafe or unrecognized Composer.
Explicit `noApprovalScan: false` (CLI `--approval-scan`) requests the detailed
scan and current terminal action offers. `noApprovalScan: true` (CLI
`--no-approval-scan`) continues to disable pane reading, including input-readiness
checks. Claude physical readiness reports `screen_not_scanned`; use Status or
the explicit detailed scan to obtain current action offers. If pane capture fails or returns no
screen excerpt, readiness reports `screen_unavailable`; inspect Status for the
capture error, restore terminal-provider access, then refresh List. Neither
case proves that a draft, menu or malformed Composer exists. Physical-terminal
Send offers remain omitted until the existing input checks pass. These reasons and their
guidance are additive diagnostics, with no action-contract, projection or
Store-protocol version change.

To use an offered physical Send, select its displayed `terminal_id` and the
existing Send tool's semantic inputs. No new public scope or token parameter
is required. An ordinary managed Send does not silently switch to this route
after an identity, ownership, Store or submission failure; uncertain input must
never be replayed through a second route. A physical dispatch receipt proves
only the stages it reports. Terminal activity observation is not native task
acceptance or completion proof.

`managed.session_count` counts distinct related Sessions found through current
or historical managed records. It does not count valid current bindings. A
positive count with null `session_id` and `session_short_ref`, and no
`binding_status`, means no current authoritative Session was selected; it is not
evidence that List lost a binding. These historical associations do not authorize
Send or ownership recovery.

## Conversation selection

Since 0.14.12 the default view prefers a verified backend as the project's CLI
entry when discovery finds one same-agent terminal and one loaded backend with
no known identity conflict. Its original conversation ID, title, status and
actions are retained. Terminal candidates remain in `terminalDebug` /
`list --terminal-debug`. Proven exact aliases combine verified capabilities;
display grouping alone does not copy terminal permissions or redirect selectors.
Multiple candidates, conflicts and terminals needing management recovery remain
visible. Rows and connections are not a count of independent tasks.

Presentation does not choose the Send transport. New Codex sends prefer the
verified shared backend. New Claude sends automatically prefer a managed Turn
through a unique controllable terminal with the same native session and process;
without that exact terminal they use the native inbox and return a Watch.
Busy/blocked state, identity conflicts and management failures do not authorize
bypassing an existing terminal through native delivery. Follow the returned
`turn_id` or `watch_id`; old tasks and receipts retain their original provider.

Starting in AKK `0.14.16`, default List also folds unnamed, unstarted Codex
candidates when there is exactly one established conversation in the same Codex
home and project, no conflicting identity, and no evidence of multiple physical
terminals. This uses an explicitly unmaterialized native history, not an empty
title or an unavailable read alone. Named threads, sole new sessions, exact
terminal aliases, active/blocked resources and multiple established threads
remain visible. An omitted candidate remains in the raw native discovery array
and `terminalDebug: true` / `list --terminal-debug`, with its original ID and
first-Send capability. The default view reports `unstarted_candidates_omitted`
and a diagnostic query. Starting its first task restores ordinary presentation
on the next List; nothing is unloaded, deleted, migrated or redirected.

This is display folding, **not proof of an abandoned or duplicate thread**.
The native loaded-list API does not expose which frontend is currently attached;
`startup-thread-start` also creates legitimate new sessions. Consequently, a
second unnamed empty frontend in the same project may require the diagnostic
view when no exact frontend identity is available. Empty candidates without an
exact terminal alias report backend reachability and unverified frontend presence,
rather than claiming a separate confirmed online CLI. Counts are not task counts.
List still does not scan persisted Watches: an uncertain first Send may have no
native task history yet and can remain folded. Inspect its original Watch or
`watches`; folding never proves that a request was not submitted or permits a retry.

Host List uses `agent-knock-knock/host-list-compact` v4. Follow
`pagination.next_args` while `has_more` is true. `listLimit` defaults to 40 and
accepts 1–100. Pages are fresh discoveries, not a frozen snapshot; restart if
membership changes invalidate a cursor. Legacy `listView=history/all`, `all=true`
and CLI `list --all` return a migration error directing callers to `watches`.

Each Host page is capped at 24 KiB of UTF-8 JSON and 12,000 weighted characters
(ASCII 1, other code points 16), including metadata. This is not a token budget.
Oversized rows retain exact IDs and a Status entry point; omitted actions do not
mean unsupported capabilities. Read exact Status for current questions, approvals
and bounded public progress. Their guidance explains that details were omitted
and directs the user to Status instead of claiming those operations are
unsupported. List contains no progress body.

Desktop catalog pagination remains separate: finish Host pages for one catalog
page, then pass `desktop_scan.next_cursor` as `desktopCursor` with the same filters
and no previous Host cursor. Explicit Desktop catalog history is a separate
native discovery view, not AKK Watch history.

## Monitoring and retention

`watches` defaults to a 24-hour lookback, 40 rows per page (maximum 100) and the
same whole-response output limits. The lookback may be set from 1 to 48 hours.
Continuation freezes the query's `as_of` and filters, not the underlying Store;
refresh before acting. Active or unresolved observations remain visible even
outside the lookback, marked `outside_window`. Retained terminal managed Turns
are listed separately from Watches so offline recovery is still discoverable.
Use each row's exact Status input to inspect it; managed rows retain the existing
pane-independent Close / callback-retry actions where permitted; these records are
observations, not additional conversations or a count of independent tasks.

Healthy completed Watch bodies become eligible for cleanup 48 hours after
settlement and callback completion. Cleanup is bounded and performed by Host
maintenance, at most once per hour and up to 100 records per pass. Active,
failed, uncertain, pending-interaction or otherwise unresolved records are
retained. Managed Turns, Sessions and native coding-agent history are not deleted.

Cleanup writes a minimal durable tombstone before removing the body. It retains
the provider, exact Watch ID, settlement/prune time and record fingerprint, not
prompts, results or callback payloads. Old deterministic Send IDs cannot recreate
a task after cleanup. An exact request for pruned history returns
`watch_history_expired` with replay forbidden, not a misleading missing-record
success. Tombstones are retained for deduplication; this is not a promise that
all AKK metadata disappears after 48 hours. Writer protocol 10 prevents older processes from recreating pruned requests;
rolling back requires a coherent pre-upgrade Store backup, not lowering the manifest.
Nothing is cleaned merely by reading
`list` or `watches`.

`callback_expected=false` alone is not a delivery failure or proof of delivery.
Native completion, controller callback acceptance and delivery to an external
chat remain separate states. Missing Watch fields in List are intentional, not
proof that Send lacked monitoring. Query `watches` or the exact returned Watch ID.

See [the operator guide](operator-guide.md), [Desktop discovery](codex-desktop-compatibility.md#find-and-select-a-conversation)
and [task recovery](backend-task-recovery.md).

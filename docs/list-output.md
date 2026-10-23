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
and bounded public progress. List contains no progress body.

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

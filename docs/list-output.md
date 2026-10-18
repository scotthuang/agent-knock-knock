# List output and history

AKK 0.14.9 bounds the entire controller-facing List result before serializing
JSON. Current conversations come first; healthy ended Watches no longer crowd
them out. Failed or uncertain callbacks, pending interactions and active
observations remain in the current view. This changes presentation, not Watch
deadlines, callback delivery or persisted history.

Starting in 0.14.11, default CLI rows combine only proven exact aliases. A
verified backend stays selectable when a same-project terminal is unresolved,
including an unknown/history viewport. These are separately addressable
connections, not a count of independent tasks. Hosts may group them by project,
but must preserve each exact target and its actions. `terminalDebug` adds routing
evidence; it is no longer needed to reveal an unassociated backend. Neither cwd
nor a startup `resume` argument authorizes redirecting a terminal target.

| Request | Included records |
| --- | --- |
| `{}` or `{"listView":"current"}` | Conversations and current/attention-needed observations |
| `{"listView":"history"}` | Healthy ended Watches and retained managed Turns |
| `{"listView":"all"}` or `{"all":true}` | Both, still paged |

An explicit `listView` takes precedence over the view selected by `all`.
`all` continues to control underlying terminal-history discovery; it does not
mean an unlimited Host response. Raw CLI `list --json` and `list --all --json`
retain their operator/debug behavior.

Follow `pagination.next_args` unchanged while `pagination.has_more` is true.
Every page is a fresh read, not a frozen snapshot. If the cursor is invalid
after membership changes, restart List. `listLimit` defaults to 40 rows and
accepts 1–100; the output budget may produce a smaller page. Counts describe
all records observed by that discovery, not only the returned page.

The compact contract is `agent-knock-knock/host-list-compact`, version 3,
action contract 31. It retains exact conversation, native task and Watch IDs
and usable action inputs. A very large row becomes a Status reference with
`details_omitted=true`; omitted actions do not mean unsupported capabilities.
Refresh exact Status to obtain pending questions, approvals and current actions.
No progress body is added to List.

`watch_summary` distinguishes current observations from healthy history.
`pagination.attention_counts` reports failed/uncertain/pending delivery and
pending interactions even when their rows appear on a later page. Categories
can overlap. Watches are observations, not extra conversations or independent
tasks. `callback_expected=false` alone does not mean missing or failed delivery;
completed notifications and unresolved delivery have different states.

Each page is limited to 24 KiB of UTF-8 JSON and 12,000 conservative weighted
characters (ASCII costs 1, other Unicode code points cost 16), including its
metadata. These are not token counts or a guarantee for every custom Host's
smaller output allowance. The current OpenClaw Codex harness was checked at
its lowest 16,000-character budget. The limits reduce returned context, not the
cost of reading the underlying local records.

Desktop catalog pagination is separate: finish the Host pages for one catalog
page, then use `desktop_scan.next_cursor` as `desktopCursor` with the same
Desktop filters and no previous Host cursor. Sidebar membership and a saved
history row still do not prove a live Desktop owner.

See [the operator guide](operator-guide.md), [Desktop discovery](codex-desktop-compatibility.md#find-and-select-a-conversation),
and [task recovery](backend-task-recovery.md) for the related workflows.

Terminal Send routing uses the same authoritative action projection as List,
then revalidates the current process, endpoint, approval and input ownership at
dispatch. A displayed action is not permission to bypass a changed terminal.
New route journals record a preparation rejection with `request_dispatched:false`
only when no executor has started. The v1 `reserved` route remains pinned;
this is neither task acceptance nor uncertain delivery. An explicit retry with
the same message ID can prepare that same route again, never switch transports.
Executor failures retain uncertain semantics. Legacy records without phase
proof are left conservative; upgrades do not replay or rewrite old outcomes.

# AKK Operator Guide

This guide is the day-to-day command and reliability reference for controlling
Codex or Claude Code processes that are already running in tmux or local Herdr.
Start with the [five-minute tmux guide](quickstart-tmux.md), the
[Herdr guide](quickstart-herdr.md), or one of the first-party Host guides for
[Pi](../connectors/pi/README.md) and
[DeepSeek Harness](../connectors/deepseek-harness/README.md).

AKK never launches a hidden replacement coding agent. The terminal remains
visible and directly usable by a human while OpenClaw, Pi, DeepSeek Harness, or
another compatible controller Host observes and controls it through AKK.

## Command reference

Direct slash commands are available in every first-party Host integration:

| Command | Purpose |
| --- | --- |
| `/akk <task>` | Send a task when AKK can prove one unique send-ready terminal. |
| `/akk <selector>: <message>` | Send to the exact selector returned by the current list. |
| `/akk list` | Discover live terminals, managed work, Watches, and safe actions. |
| `/akk watch <terminal-id>` | Observe one exact terminal without changing it. |
| `/akk unwatch <watch-id>` | Stop one read-only Watch. |
| `/akk threads <terminal-id>` | List resumable native threads for one terminal. |
| `/akk new-thread <terminal-id>` | Start a clean native coding-agent thread. |
| `/akk clear-thread <terminal-id>` | Alias for the same clean-thread lifecycle action. |
| `/akk resume-thread <terminal-id> [thread]` | Resume one exact native thread. |
| `/akk status <turn-or-watch>` | Inspect a managed Turn or Terminal Watch. |
| `/akk respond <turn-id> <answer>` | Answer a question inside the same managed Turn. |
| `/akk cancel <turn-id>` | Interrupt one exact active managed Turn. |

`/akk list` is terminal-first. Each live pane appears once in `terminals[]`.
The optional `managed.current_turn` is active work; `managed.recent_turn` is
retained history and does not occupy the terminal. Attention-needed records
whose pane is unavailable appear in `unavailable_managed_turns[]`.

Human-facing selectors are a slash-command convenience. Structured tools use
semantic identities: `session_id` for strict continuation, `terminal_id` for
the currently verified physical terminal, `turn_id` for one managed dispatch,
`watch_id` for read-only observation, and `native_thread_id` for resume. A
`session_exact` action targets the continuing native context; a
`terminal_follow_current` action targets the current verified context in the
pane. Except for user-intent-first Watch, always use the exact action and
prefilled semantic IDs from a fresh list.

## Reliable Send

The v23 `action_contracts` expose model-facing semantic IDs only. The trusted
adapter privately derives and revalidates terminal, process, binding, native
thread, composer, approval, handoff, revision, and compare-and-swap evidence.
Callers never supply those opaque fences.

A managed Send verifies one terminal and native context, creates one Turn,
proves exact request acceptance, monitors that Turn, and returns completion or
attention callbacks to the initiating Host. A completed `turn_id` is history,
not a destination for another task. A question inside a live Turn uses the
advertised `respond` action with that Turn's `turn_id`.

The user-priority `terminal_user_explicit` path requires one exact live
physical terminal/process and a scanned, non-blocked approval state. Broken
AKK Turn, Session, transfer, transition, ledger, or Store state cannot veto the
user's explicit Send. Codex physical fallback does not depend on Composer
visibility, stability, or exactness: it sends `C-u` once, injects the new
request, waits through the paste window, and dispatches Enter exactly once.
After text injection, Composer observation cannot veto Enter. Claude Code
fallback remains exact-empty-only.

AKK first takes the managed path where its stronger pre-input requirements
hold. Otherwise it may deliver unmanaged work once and best-effort attaches a
Terminal Watch that provides the completion callback. Watch preparation or
persistence failure is reported but never vetoes, revokes, or retries the
successful Send. If terminal delivery or native acceptance is uncertain, AKK
does not retry automatically; inspect Status, the exact pane, or the returned
Watch instead.

On first attach, the target terminal must be explicitly named by the user. AKK
never guesses which already-running pane should receive the task. An omitted
target is allowed only when AKK can prove one unique eligible terminal.

### Codex candidate attribution

The human-priority Codex path also covers a status-card-only Session, a
quiescent managed pane whose foreground rollout cannot be selected, and a
supported manual `/clear` whose new logical thread appears before its rollout
materializes. The complete exact inventory domain binds the provider terminal,
PID and process birth, workspace and canonical endpoint, and every open
rollout's UUID, descriptor, device, inode, canonical path, and
pre-submit byte offset. A `/clear` resume hint is advisory only, never routing or acceptance
authority.

Under the terminal lock, AKK isolates the predecessor, creates a separate
zero-UUID provisional Session and Turn, sends the real request once, and binds
only the single rollout that proves exact request acceptance. A rollout-backed
Codex row therefore advertises `terminal_follow_current`, not `session_exact`;
a cached or direct `session_exact` attempt rejects before task text and never
downgrades itself. Only released predecessor Turn history from an earlier
binding epoch is excluded from current authority. Use only the freshly listed
semantic-ID action.

Until promotion commits, strict `session_id` send, `respond`, managed
`approve`, `cancel`, native lifecycle, callback delivery, and `native_inspect`
remain unavailable. This provisional path can still work in a narrow pane
because it binds from acceptance rather than automating native `/status`.

## Terminal Watch

Watch is read-only and user-intent-first:

```text
/akk list
/akk watch <exact-terminal-id>
/akk status <watch-id>
/akk unwatch <watch-id>
```

The fresh list is the safest way to copy a complete `terminal_id`, but missing
Watch advertisement, coding-agent version uncertainty, unusable task artifacts,
or existing managed ownership are warnings rather than authorization vetoes.
Watch fails only when the exact terminal/process cannot be identified, neither
an exact task anchor nor a read-only terminal-activity path exists, or the
durable Watch record cannot be created.

An exact provider anchor produces `watch_mode="exact_task"` and
`confidence="exact"`. Without one, AKK can use
`watch_mode="terminal_activity"` and `confidence="best_effort"`: it must first
observe working or approval activity and then stable idle. That callback proves
only that the observed activity became idle, not that one uniquely identified
task succeeded, and it contains no exact-task completion text.

A Watch sends no terminal input and does not adopt, reserve, block, interrupt,
approve, or own the selected task. Manual-Watch approval events are
notification-only and never participate in auto-approval. Durable Watch state,
notification identities, and callback outboxes make restart recovery
idempotent. A managed Turn monitor remains preferable when exact Turn
attribution already exists.

## Sessions, Turns, and native threads

AKK keeps these identities separate:

```text
tmux or Herdr terminal / verified process incarnation
├─ native Codex or Claude Code session
│  └─ AKK Session (session_id)
│     ├─ Turn (turn_id)
│     └─ Turn (turn_id)
└─ Terminal Watch (watch_id)
```

New and resume are native lifecycle transitions. They create or activate an
AKK Session but create no Turn. Run `/akk threads <exact-terminal-id>` to get
the current candidates. The output includes deterministic numbers,
collision-safe display-only short IDs, and each complete native thread UUID.
The number and short-ID resume forms belong only to that displayed snapshot;
neither is a durable identity or model authority. They expire after five
minutes and after terminal, process, workspace, binding, candidate-set, or
relevant action changes.

`previous` is advertised only when the current Session's latest committed
transition and fresh discovery prove exactly one resumable source. If
`previous` is present, use only its exact prefilled semantic-ID action for a
natural-language “刚才那个” request. Never substitute the newest terminal row.

Do not ask AKK to send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`,
`/side`, `/btw`, Claude `/branch`, or another first-line native slash command
as an ordinary task. Use the advertised lifecycle or native-inspection action,
express the outcome in natural language, or type an unsupported command
directly in the TUI. AKK revalidates the entire candidate snapshot before
terminal input; candidate-set changes fail closed. A replaced or changed
transcript/rollout cannot be resumed under stale metadata.

## AKK Status and native inspection

`/akk status` reads AKK state and a bounded terminal screen. It does not run the
coding agent's `/status`. Native inspection is a separate, closed action:
`native_inspect({terminal_id,inspection:"status"})`. It accepts no arbitrary
command and creates no AKK Turn, Session, receipt, monitor, or callback.

Codex native `/status` inspection requires an exact viewport of at least 80
columns so the complete UUID can be proven. An ordinary terminal-scoped task
does not run `/status` and does not fail merely because the pane is narrow; it
can bind from exact native acceptance afterward. Claude inspection must prove,
parse, and dismiss one fresh Status panel and return to the same idle composer.
Other complete `x.y.z` agent versions remain callable with a compatibility
warning; incompatible runtime behavior fails or becomes uncertain rather than
being blocked by a version allowlist.

## Approval boundaries

Approval always requires the current exact prompt and explicit human intent.
Managed approval uses `approve({turn_id})`; terminal-scoped manual Codex
approval uses `approve({terminal_id})` when the current list advertises it.
On an unmanaged raw-terminal row, that action is prefilled with its exact
`terminal_id`; never construct or guess the target.

The private approval fence is prompt-scoped. It binds the adapter-isolated
exact unredacted approval region, terminal/process identity, decision keys,
prompt kind, working directory, reason, and request evidence. The whole-screen
digest and redacted excerpt are diagnostic only: output outside the approval
region may keep scrolling without invalidating the same prompt. Any change
inside the exact region—including a command or an otherwise identically
redacted secret—rejects and sends zero approval keys.

Terminal-scoped approval leaves Session and Turn identity unchanged, is never
available to auto-approve, and must not be retried blindly after an uncertain
transport result. Unsupported, stale, changed, ambiguous, or ownership-drifted
prompts remain for the human to resolve in the coding-agent TUI. OpenClaw's
optional exact-command auto-approval policy is documented separately in
[OpenClaw operations](openclaw-operations.md#automatic-approval).

## Recovery and advanced controls

Use fresh List and Status before every recovery action. Advanced slash commands
appear only when the matching state makes them meaningful:

| Command | Use |
| --- | --- |
| `/akk doctor` | Diagnose installation, Host, terminal, and coding-agent readiness. |
| `/akk approve <turn-or-terminal>` | Approve one current prompt after explicit review. |
| `/akk renew <turn> <minutes>` | Restart monitoring for one still-live stalled Turn without terminal input. |
| `/akk retry-callback <turn>` | Retry one persisted failed callback with its original identity. |
| `/akk close <turn>` | Release AKK management without terminal input or stopping the coding agent. |

Explicit Close is the user's management escape hatch. It has priority over
broken deferred-transfer or handoff state, closes the selected Turn first, and
then best-effort releases only linked AKK metadata. Refresh List afterward; if
the agent is still working, a new read-only Watch can observe it.

An uncertain terminal mutation is not a retry instruction. Do not resend,
approve, cancel, or repeat Enter blindly. Inspect the exact pane and durable
Status, then use only the action currently advertised by AKK.

## Structured tool surface

First-party Hosts register the same 16 semantic tools: list, watch, unwatch,
list resumable threads, native inspect, new thread, reconcile binding, resume
thread, status, send, respond, approve, renew, retry callback, cancel, and
close. Model-facing mutations contain semantic IDs and user content only.
Selectors, pane routes, draft text, fingerprints, tokens, revisions, candidate
fences, and binding generations stay inside the trusted Host adapter.

For the full lifecycle, callback, identity, handoff, and persistence contract,
see the [Terminal Handoff Protocol](bidirectional-agent-protocol.md). For
configuration and recovery specific to OpenClaw, see
[OpenClaw Operations](openclaw-operations.md).

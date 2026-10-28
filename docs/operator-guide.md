# AKK Operator Guide

This guide covers daily use of existing Codex CLI backend conversations,
Codex Desktop conversations, and Codex or Claude Code terminals. OpenClaw,
Pi, DeepSeek Harness, or another compatible Host can act as the controller.
AKK 0.14.0 introduces the backend and Desktop features described here; see the
[README](../README.md) for installation. Each connector's pinned runtime
determines its supported capabilities.

Choose the guide for the coding agent you already use:

| Existing coding-agent environment | Setup and capability guide |
| --- | --- |
| Codex CLI connected to its shared backend | [CLI backend guide](codex-cli-native-compatibility.md); no tmux or Herdr required |
| Codex Desktop | [Desktop guide](codex-desktop-compatibility.md); keep the intended conversation open in the supported app |
| Codex or Claude Code in a shared terminal | [tmux quick start](quickstart-tmux.md) or [Herdr quick start](quickstart-herdr.md) |

For controller-specific setup, see [OpenClaw operations](openclaw-operations.md),
the [Pi guide](../connectors/pi/README.md), or the
[DeepSeek Harness guide](../connectors/deepseek-harness/README.md).
AKK never launches a hidden replacement coding agent. Human and controller
continue in the original conversation or shared terminal.

Start with AKK List, choose the intended conversation by title and project,
then use its advertised Send, Status, Watch, or interaction action. Backend
tools use the returned `conversation_id`; the controller supplies its own
session identity. Save the task's returned `watch_id` and, for a managed Send,
its equivalent `turn_id` for follow-up. A project path or title alone is never
task identity. [Backend task recovery](backend-task-recovery.md) explains how
to resume observation or release management for that exact task.

Host List returns bounded pages of currently discoverable conversations. Follow
`pagination.next_args` for remaining conversations. Use `agent_knock_knock_watches`
or `/akk watches` for recent monitoring and unresolved callbacks; absence of Watch
fields in List does not mean Send had no monitoring. See
[List and Watch inventory](list-output.md) for the 24-hour query window,
48-hour eligible-history retention and separate Desktop catalog cursor.

## What can I do with this conversation?

Read the guidance beside each conversation. It explains what works now, what
is preventing other operations, and the next step. The controller should give
this explanation in your language instead of asking you to interpret internal
error codes. It changes when the conversation's state changes.

| What List shows | What to do |
| --- | --- |
| Can send and watch | Send a new task when offered, or ask AKK to watch the task already running. |
| Can send, but no active task to watch | Send your task. Monitoring starts with that Send; keep its returned task reference. An idle conversation is usable. |
| Can send to a window whose native conversation is unverified | Select that exact terminal's offered Send. AKK can enter text and submit Enter, but you must inspect the result in the window because native acceptance and completion are unproven. |
| Window is in the background-session interface | Use its physical Send if offered and inspect the result there. If Send is unavailable, continue manually or open an ordinary foreground Claude conversation and refresh List. |
| Can only inspect or watch the terminal and cannot identify the Claude conversation | AKK has retried identification without typing into the terminal. Use the original terminal to finish or safely stop any work, then follow the recovery steps below. |
| Needs approval or management recovery | Open Status for that exact conversation or task and follow its currently offered response or recovery action. |
| Details omitted from this List page | Open Status for that row. Missing details do not mean the conversation lacks those features. |

For a sendable background window, the instruction means:

> 可以向此窗口发送任务。AKK 会输入文字并提交，但目前无法可靠确认后台任务的接受和完成状态；请在窗口中查看执行结果。

Choose the exact terminal entry and its offered Send action. This is ordinary
terminal input, not a direct background-worker connection, and it does not
promise a task-completion callback. An existing managed task that failed is not
automatically retried through this route. If input might already have happened,
inspect the original result before considering another send.

If the window is showing a background conversation and physical Send is not
offered, you can keep working in the current window manually. An ordinary
foreground Claude conversation can instead provide native task identity and
monitoring when those operations are offered. Reopening the same background
conversation after restarting will not add that proof. Neither option converts
the existing background conversation or transfers its work. In the inspected
Claude Code 2.1.295 installation,
`tclaude attach --help` documents `Ctrl+Z` as returning to the shell while the
background session keeps running; check the installed command's help before
applying that shortcut to another runtime or interface.

If Claude remains unidentified and List cannot confirm that more specific
background-view explanation:

1. Open the named pane in Herdr or tmux and check what is running there. You can
   continue using Claude directly. If its current physical Send action is
   offered, you can also select that terminal for input while inspecting the
   result manually.
2. After finishing or safely stopping any current work, exit Claude with `/exit`
   and relaunch it with your usual command in the same project directory. If
   resuming history opens a background conversation, use the guidance above
   instead of repeatedly restarting.
3. Refresh AKK List and select the newly identified conversation. Do not resend a
   task whose earlier delivery is uncertain; inspect its saved task reference.
4. If the row still cannot receive work, keep using that terminal directly and
   report the discovery limitation. A missing or failed diagnostic check does
   not prove a background conversation or a reader bug. Relaunching can refresh
   registration, but cannot guarantee a repair.

You do not need to restart the controller Host for this recovery attempt. A
terminal Watch can report terminal activity while identity is unresolved; it
cannot promise exact task completion. A count of related managed Sessions is
history, not proof that this newly discovered conversation is currently bound.

Claude can resume the same native thread after its process exits. An unchanged
thread UUID is expected in that case; the process PID and startup identity must
still be verified afresh. New thread uses the same safe Session reattachment as
Send when the prior process is conclusively gone or the same PID has a proven
new incarnation. AKK preserves the Session history and advances its binding
generation under the terminal and Store locks, rather than deleting the claim.
This recovery does not require a manual reconciliation for an otherwise healthy
Session. Active or unverifiable owners, unfinished Turns or thread transitions,
and cross-Store authority conflicts still prevent automatic recovery.

An idle-looking Claude window alone does not prove managed control is ready.
List applies each operation's existing reader and idle checks for the current
process; managed Send also needs a safe transcript boundary
for acceptance and completion monitoring. When one of these checks fails, List
explains the missing evidence and does not offer that managed operation. Wait
for current work to finish and refresh List for reader-state failures; inspect
Status and the transcript diagnostic for file-access or incomplete-write
failures. Do not weaken transcript permissions or delete history to force a
Send. An independently offered physical terminal Send remains a separate,
explicit choice and cannot promise native task acceptance or completion.

List is an observation, not a reservation. Execution repeats the checks before
input, so a process, thread, file or prompt that changes after listing can still
cause a refusal. Refresh List after resolving the reported condition; never
automatically retry a task whose earlier delivery is uncertain.

## Command reference

Direct slash commands are available in every first-party Host integration:

| Command | Purpose |
| --- | --- |
| `/akk <task>` | Send a task when AKK can prove one unique send-ready terminal. |
| `/akk <selector>: <message>` | Send to the exact selector returned by the current list. |
| `/akk list` | Discover conversations and their supported actions. |
| `/akk watches` | Read recent monitoring and unresolved records; follow pagination for more. |
| `/akk watch <terminal-id>` | Observe one exact terminal task. |
| `/akk unwatch <watch-id>` | Stop observation of one terminal or backend Watch without stopping its native task. |
| `/akk threads <terminal-id>` | List resumable native threads for one terminal. |
| `/akk models <terminal-id>` | Inspect the current native model and reasoning choices for one exact idle terminal. |
| `/akk permissions <terminal-id>` | Inspect the exact Codex terminal's native permission choices. |
| `/akk set-permissions <terminal-id> <advertised-mode-id>` | Apply the selected native permission mode before a task. |
| `/akk repair-model-control <terminal-id>` | Clear only an exact advertised stale profiled Codex 0.154.0/0.155.1 `/model` Composer surface or open native picker and prove an empty Composer. |
| `/akk set-model <terminal-id> <model> <reasoning-effort>` | Select one exact tuple from the immediately preceding model catalog. |
| `/akk new-thread <terminal-id>` | Start a clean native coding-agent thread. |
| `/akk clear-thread <terminal-id>` | Alias for the same clean-thread lifecycle action. |
| `/akk resume-thread <terminal-id> [thread]` | Resume one exact native thread. |
| `/akk status <turn-or-watch>` | Inspect the original managed terminal Turn or backend/terminal Watch. |
| `/akk respond <turn-id> <answer>` | Answer a question inside the same managed Turn. |
| `/akk cancel <turn-id>` | Interrupt one exact active managed Turn. |

AKK List presents **CLI** and **Desktop** in one `conversations[]` collection,
with Codex/Claude Code as the agent type. Choose the displayed conversation and
action; AKK selects the connection. The default view prefers the verified backend
entry for a one-to-one same-agent/project discovery pair, preserving the
backend's exact ID, status and actions. A terminal candidate does not donate
unverified capabilities or management to that entry. Multiple candidates,
known identity conflicts and terminal attention/recovery records stay visible;
direct-only and terminal-only CLI conversations remain available.
Use `terminalDebug: true` or `list --terminal-debug` for all connections and
routing details. A display group is not proof that its candidates are the same
native session, and neither rows nor Watches are a task count.
Bound task and interaction IDs retain their original provider; uncertain input
is never retried through another transport. For new Sends, Codex prefers the
verified shared backend; Claude automatically uses a managed Turn through a
unique controllable exact terminal, or a native inbox Watch when no such
terminal exists. Claude approvals follow the managed Send's original `turn_id`
after fresh Status. Native Claude Watches provide notify-only waiting hints,
without approval authority. A terminal's busy/blocked state, ownership or Store
conflict does not authorize native bypass. The
[CLI backend guide](codex-cli-native-compatibility.md#automatic-conversation-routing-2026-10-10)
and [Claude control guide](claude-cli-direct.md) describe the respective routing
evidence and presentation boundaries.

The terminal-specific commands in the table require a physical terminal;
Desktop interaction, model, permission, and cancellation controls use their
advertised semantic tools. Backend and terminal capabilities are distinct.
Raw CLI output retains provider arrays, including `terminals[]`, for diagnostics.
Within a terminal row, `managed.current_turn` is current managed work. Retained
managed Turn history, including records whose pane is unavailable, is queried
separately through `watches` and exact Status.

Terminal status has three independent evidence axes. `screen_state` describes
the bounded live TUI (`idle`, `working`, `awaiting_approval`, or `unknown`);
`native_identity_state` describes foreground native-session resolution
(`resolved`, `ambiguous`, `verified_absent`, or `unavailable`); and
`durable_activity_state` describes exact rollout/transcript task evidence
(`idle`, `working`, or `unknown`). The legacy `activity_state` remains a
conservative compatibility projection and can therefore be `unknown` while
`screen_state` is `idle`. These fields are diagnostic; `available_actions`
remains the authority for tool calls.

Human-facing terminal selectors are a slash-command convenience. Terminal
structured tools use semantic identities: `session_id` for strict continuation, `terminal_id` for
the currently verified physical terminal, `turn_id` for one managed dispatch,
`watch_id` for read-only observation, and `native_thread_id` for resume. A
`session_exact` action targets the continuing native context; a
`terminal_follow_current` action targets the current verified context in the
pane. Except for user-intent-first Watch, always use the exact action and
prefilled semantic IDs from a fresh list.

## Reliable Send

Backend Send persists one submission and monitors its original accepted native
task. Reusing its message ID returns the same record; uncertain submission
evidence never triggers an automatic resend. See the [CLI backend guide](codex-cli-native-compatibility.md)
and [Desktop guide](codex-desktop-compatibility.md) for native acceptance and
interaction capabilities. The remainder of this section covers terminal Send,
including its physical-input fallback and terminal response adapters.

Starting in AKK 0.14.1, new Send monitoring and explicit or
automatic Watch share a default **720-minute hard deadline**. Explicit request
parameters override the Host hard-timeout configuration, which overrides that
default. Save and use the Watch returned by Send; do not add another Watch merely
to obtain completion callbacks. Expiry ends observation, not the native task.
Existing saved deadlines and repeated message IDs are not extended by an upgrade.
Managed terminal inactivity remains a separate 60-minute default.

The v31 `action_contracts` expose model-facing semantic IDs only. The trusted
adapter privately derives and revalidates terminal, process, binding, native
thread, composer, approval, handoff, revision, and compare-and-swap evidence.
Callers never supply those opaque fences.

A managed Send verifies one terminal and native context, creates one Turn,
proves exact request acceptance, monitors that Turn, and returns completion or
attention callbacks to the initiating Host. A completed `turn_id` is history,
not a destination for another task. A question inside a live Turn uses the
advertised `respond` action with that Turn's `turn_id`.

Native interaction prompts use `respond_interaction`, not ordinary `respond`.
For a supported pending step, the managed monitor sends an
`interaction_required` callback to wake the owning controller conversation.
That callback is notification only and carries no private response authority:
first obtain the current managed Turn's `interaction_state` from Status in the
same controller conversation, show that exact step to the user, and submit only
its advertised semantic question/option IDs or bounded typed text. A blocking
`questionnaire` does not carry `delivery_mode`. A Codex `async_question`
coexists with a task that remains `working`; responses default to advertised
`steer_current_turn` or explicitly select advertised `queue_next_turn`: `steer_current_turn` delivers the answer to that running turn,
while `queue_next_turn` queues it for the next turn. One call resolves one
current step; the monitor notifies the next supported step when it appears.
Status remains the manual refresh fallback. Never submit raw keys, shortcut
chords, or menu indexes, and never respond to `manual_required`, expired,
changed, secret-bearing, or uncertain state. Codex 0.154.0 and 0.155.1 use
version-bound TUI execution; main-only notification and stable-question-ID
wrappers added after 0.155.1 are not assumed to exist in either release.

The initial async adapter accepts at most four fully visible suggestions plus
native Other, and custom answers must be a short, fully visible single line
without leading/trailing whitespace. Wrapped or clipped input cannot prove the
postcondition and stops without a submit key. Codex's own collapsed-question
timer still applies: AKK does not keep a question alive or reopen an expired
one. Refresh Status before responding; an absent question is not retryable.

The user-priority `terminal_user_explicit` path requires one exact live
physical terminal/process, a scanned non-blocked approval state, and no proven
input-owning questionnaire, editor, menu, or read-only viewer. Broken AKK Turn,
Session, transfer, transition, ledger, or Store state cannot veto the user's
explicit Send within the same Store authority. A conflicting or unfinished
cross-Store authority transfer still blocks input, including physical fallback.
For Codex, neither can parsed working activity, an existing draft, or
ordinary Composer visibility, stability, or exactness. Claude physical Send
requires an empty recognized main Composer, no existing stashed draft, a known native footer, and no running
or unproven foreground turn; background shells alone do not block it. Codex physical fallback
sends `C-u` once. Claude Code refuses an existing stashed draft before input. On a freshly empty main Composer it uses one `C-s` to check for a hidden stash; restored content stops task submission and remains for the user. It writes no sentinel and deletes no draft. Each
then injects the new request,
waits through the paste window, and dispatches Enter exactly once. After text
injection, Composer observation cannot veto Enter. Unreviewed Codex fullscreen
frontends additionally require a recognizable styled Composer before clearing
and a fresh empty Composer afterward, before any task text is sent.

Claude physical-input preparation finishes before task text or Enter. A visible `› stashed` indicator refuses the attempt before any terminal input. When no stash is shown, AKK rechecks the empty main Composer and uses `C-s` once to restore any hidden stash. If content appears, it stops and leaves that content in the input box for the user; it does not re-stash or delete it. If the probe or final empty check is uncertain, it stops without task text or Enter and does not retry the key. This replaces the former sentinel transaction: no new marker is written and no editing keys delete a draft. There is no Composer observation or cleanup after task text or Enter. Ordinary managed Sends, Codex clearing and independent Watch monitoring are unchanged. This is refusal with manual recovery, not a guarantee of protecting drafts against simultaneous human input; avoid typing in the pane during an attempt. Screen capture and key delivery are not an atomic keyboard lock. A transport acknowledgement cannot prove that Claude processed `Ctrl+S`; ignored keys or cropped native indicators can leave stash occupancy unproven. AKK does not overwrite that unknown slot with a marker.

If List or Send reports a stashed draft, open that exact window and wait for the foreground turn to finish. Preserve any visible draft first. With the main input box empty, press `Ctrl+S` once to restore the stash, then save, send, or clear it yourself before refreshing List. AKK cannot identify hidden content just from the stash label. If restoration reveals `[AKK replacing current draft ...]`, it may be residue from an older failed AKK cleanup: remove only that marker after checking the text, preserve any other content, and do not press Enter on the marker. `Draft restored` is a transient restore notification; an accompanying `› stashed` still reports an occupied slot and remains a refusal condition. Do not repeatedly toggle `Ctrl+S` or retry an uncertain AKK attempt automatically.

Within an explicitly selected physical-input operation, AKK can use managed
delivery where its stronger pre-input requirements hold. Otherwise that
operation may deliver unmanaged input once and best-effort attach the strongest
safe Terminal Watch available. A verified exact-task Watch can provide a
completion callback; that proof is not supplied by a physical dispatch receipt.
An ordinary Claude managed Send does not change to physical input after failure.
Read the actual receipt: absent native identity
means acceptance and completion remain unproven, including for a window showing
a background conversation. Exact preparation failure may leave a
request-correlated terminal-activity Watch when the physical identity and
observation path remain valid. Its callback
reports stable idle with best-effort confidence, never exact task success.
Watch persistence failure never vetoes, revokes, or retries a successful
Send. Uncertain native probe input or unsafe input surfaces stop before task
text; they do not authorize this fallback. If clear or request input may have occurred and terminal
delivery or native acceptance is uncertain, AKK does not retry automatically;
inspect Status, the exact pane, or the returned Watch instead.

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

### Explicit Codex foreground identification

When a recent `/clear` has not yet materialized a rollout, or several open
rollouts make `native_identity_state="ambiguous"`, a fresh List may advertise
two Codex-only actions. `identify_foreground({terminal_id})` holds the exact
terminal lock and sends the closed `/status` probe exactly once, but performs
no Store mutation and creates no Session, Turn, receipt, monitor, or callback.
The returned proof expires after 30 seconds and is diagnostic only: it cannot
authorize Send, approval, native-interaction response, lifecycle input, or a later
binding after the lock is released.

`identify_and_send({terminal_id,request})` is the actionable atomic form. It
keeps one terminal lock from foreground identification through the one task
dispatch. The status UUID is provisional; only one rollout that later accepts
the exact request can become durable Session/Turn identity. A changed or
uncertain probe boundary stops before the task and is not retried
automatically. This optional enhancement is not a prerequisite for ordinary
human Send: ordinary Send retains its user-priority behavior. Codex 0.158.0/0.159.0/0.159.2
exact Send and active-task Watch use a separate closed `/status` transaction
to bind the foreground paginated thread. List never types an identity probe.
Status for an exact backend task does not use terminal input. A targeted
conversation Status for an unbound, idle Codex terminal may use the separate
closed routing inspection described under [Status](#akk-status-and-native-inspection).

## Terminal Watch

The [terminal handoff demo](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/assets/akk-tmux-handoff-demo.mp4)
shows OpenClaw giving Claude Code a task and handing its result to Codex
through tmux; both terminals remain available for direct human use.

Watch follows the exact terminal selected by the user. Codex 0.158.0/0.159.0/0.159.2 exact
Watch creation types a closed `/status` command into an available main Composer;
subsequent observation is read-only. Newer Codex versions may use the same
strict observed UI and paginated read contracts. See the
[upgrade compatibility policy](callback-compatibility.md).

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

After initial Codex foreground binding, Watch observation sends no terminal
input and does not adopt, reserve, block, interrupt,
approve, or own the selected task. Manual-Watch approval events are
notification-only and never participate in auto-approval. Durable Watch state,
notification identities, and callback outboxes make restart recovery
idempotent. A managed Turn monitor remains preferable when exact Turn
attribution already exists.

## Sessions, Turns, and native threads

For terminal-managed work, AKK keeps these identities separate:

```text
tmux or Herdr terminal / verified process incarnation
├─ native Codex or Claude Code session
│  └─ AKK Session (session_id)
│     ├─ Turn (turn_id)
│     └─ Turn (turn_id)
└─ Terminal Watch (watch_id)
```

Backend Send instead returns one persisted task ID as both `watch_id` and
`turn_id`; a standalone backend Watch has no Send management. These task IDs
stay bound to the original thread and native task. They do not authorize the
terminal lifecycle commands below.

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
as an ordinary task. Use the advertised lifecycle, native-inspection, or
Codex foreground-identification action, express the outcome in natural
language, or type an unsupported command directly in the TUI. AKK revalidates
the entire candidate snapshot before terminal input; candidate-set changes
fail closed. A replaced or changed transcript/rollout cannot be resumed under
stale metadata.

## Permission settings

Send preserves the selected conversation's existing permission mode. Use an
explicit advertised permission action to change it before sending a task.
Claude Code's `default` mode (`⏸ manual mode on`), plan, accept-edits, and
bypass modes do not prohibit submitting user task text. Managed Send injects
the task and dispatches Enter without changing that mode; any subsequent tool
approval remains a separate interaction. A real approval dialog or changed
terminal identity still requires the corresponding interaction or recovery.
The [CLI backend](codex-cli-native-compatibility.md) and
[Desktop](codex-desktop-compatibility.md#settings-and-cancellation) adapters
apply and verify the selected conversation's native settings. For a Codex
terminal, [Codex permissions](codex-permissions.md) covers the current native
choices and exact idle-terminal checks. Full Access is an explicit supported
choice; AKK handles its native confirmation without an additional prompt.

Claude Code currently has no AKK `permission_options` or `set_permissions`
operation. Supported managed approvals decide one current request; they do not
change the session's permission mode. The native sender's `bypass` or
`prompting` declaration is message metadata, not a permission-setting API.

Host Send uses the dispatch stages' own lock, transport, and acceptance
timeouts instead of the relay's generic 90-second deadline. Slow discovery
must not kill the dispatcher between text injection and Enter. Explicit Host
cancellation and explicitly supplied relay deadlines still apply. If a sender
is interrupted, inspect its durable submission receipt before deciding what
to do; an unproven receipt never authorizes an automatic resend or Enter.

## Safe model control

This section describes terminal model control. Desktop settings use the
[Desktop settings API](codex-desktop-compatibility.md#settings-and-cancellation)
and do not expose a model catalog; they accept an explicitly requested model
and effort. The direct CLI backend has no equivalent native model operation.
Use only the provider capability advertised by the selected conversation.

Model control is a two-step, current-snapshot operation. Start from a fresh
`/akk list`, copy one complete `terminal_id` whose row advertises
`available_actions.model_options`, then run:

```text
/akk models <exact-terminal-id>
/akk set-model <exact-terminal-id> <advertised-model-id> <advertised-reasoning-effort>
```

The first command opens and closes the agent's native model UI as one bounded
inspection. It returns the effective model, the semantic model IDs currently
available to that account and runtime, and each model's available reasoning
efforts. This is dynamic authority, not a static AKK allowlist: copy one exact
model ID and one exact reasoning value from that result. Both values are
required; an omitted, invented, or unadvertised effort fails before native
model-selection input. The structured postcondition remains authoritative
about the effective tuple.

The matching OpenClaw tools are
`agent_knock_knock_model_options({terminal_id})` and
`agent_knock_knock_set_model({terminal_id,model,reasoning_effort})`. The
options result and its private physical-terminal/catalog authority belong to the
same controller
conversation and are consumed by one set-model attempt. Relist after any pane,
process, catalog, or UI change, or after any failed attempt.
Neither tool accepts a slash command, raw key, menu index, display label,
scope override, token, or fingerprint.

If a failed profiled Codex 0.154.0/0.155.1 attempt leaves an exact `/model` popup or an
exact bare `/model` Composer, List may advertise both
`model_options({terminal_id})` and `repair_model_control({terminal_id})`.
The former uses separate residual-bound authority to continue that exact slash
command into read-only catalog discovery without retyping it. The latter is the
cleanup-only alternative; its equivalent human command is
`/akk repair-model-control <exact-terminal-id>`. It accepts only the terminal
ID and privately revalidates the pane, process, residue, approval state, and
absence of an active Turn before every reversible cleanup input. It never
presses Enter, selects a model, submits a task, or handles an approval or
questionnaire. Success requires an exactly empty Composer. An uncertain
continuation or repair is not retryable.

If the exact native model picker is already open, List projects the terminal
as non-idle and advertises only `repair_model_control`. That repair may dismiss
the exact picker but never receives authority to press Enter.

Both steps use explicit current-snapshot authority for the same exact physical
terminal and coding-agent process. Profiled Codex 0.154.0/0.155.1 may use either one exact current
native Session or a verified-zero-rollout pane, and the Codex-only
`identify_foreground` diagnostic is not a prerequisite. Claude Code still
requires one exact current native Session. The pane
must remain safely idle with an exactly empty Composer, except for the exact
Codex residual continuation described above. An active Turn, working
agent, approval, questionnaire or editor, read-only viewer, non-empty Composer,
ambiguous or multi-rollout Codex identity, stale physical snapshot, incompatible
runtime contract, or changed catalog fails closed
with no model-selection input. The private multi-step native sequence
revalidates each frame and must return to the main Composer without submitting
a task or answering a prompt.

Claude Code model controls do not require an exact regression-tested version.
Other complete `x.y.z` versions may attempt the supported picker contract, and
`model_control.reason` identifies an unverified profile. The live picker,
closed choices and session-scope footer must still be recognized. Missing or
malformed versions and unknown UI layouts do not authorize model selection.
Standard `claude` and configured wrappers such as `tclaude` share this behavior.

Provider scope is explicit in both results:

- Codex reports `scope="current_and_new_sessions"`. Its native model flow
  changes this session and persists the selected model as the default for
  future Codex sessions. Ordinary reasoning efforts through `max` are also
  persisted. Codex treats `ultra` specially: it is effective only in the
  current session, while the future-session effort falls back to a non-Ultra
  value. The scope label therefore does not claim that Ultra itself persists.
  These are intentional, visible side effects of the approved native
  operation; AKK does not edit `~/.codex/config.toml` directly or restore it
  afterward.
- Claude Code reports `scope="current_session"`. Its native session-only path
  changes the open session and leaves new-session defaults unchanged.

A successful result is `changed` or `already_effective` and reports the
current session under `effective`, the future Codex defaults under
`new_session_defaults`, and whether they changed under `defaults_changed`.
For an Ultra request, expect `effective.reasoning_effort="ultra"` and only the
persisted model in `new_session_defaults`. The native TUI does not expose the
exact non-Ultra effort it chooses for new sessions, so AKK omits that field
rather than guessing; never infer that Ultra became a future default from
`scope="current_and_new_sessions"` alone.
`outcome="uncertain"` means native input may have taken effect but AKK could
not prove the final state. It carries `do_not_retry=true`: inspect the shared
pane, then obtain a new model catalog before any deliberate new attempt. Model
control creates no AKK Turn and never approves, answers, or submits coding
work.

## AKK Status and native inspection

Status follows its target. An exact backend task's `watch_id` or Send-produced
`turn_id` reads that original backend's native state without terminal input.
A backend conversation Status reads the selected native conversation. Bound
terminal Turns and Watches retain their original observation route. List
never types into a terminal.

AKK 0.14.1 adds a single `progress` object to CLI
backend and Desktop Status. Conversation Status selects its current native turn;
Watch Status always selects the Watch's original turn, even after a newer task
starts. The latest public commentary and up to two short action type/status
summaries share an 800-Unicode-code-point body budget, with unused space shared
between them. Redaction precedes truncation, which preserves complete graphemes.
Reasoning, analysis, raw command output, tool arguments and diffs are excluded.
This is a progress-body limit, not a limit on the whole Status JSON. List does not
include this body, and the terminal screen contract is unchanged.

`progress.native_turn_id` identifies the selected task; `read_at` records the
read time. `latest_item_at` is a native timestamp of the displayed progress, or
`null` if none is available; it is never replaced with the read time. `truncated`
reports shortening of the selected progress body or omission of code blocks. `state: "no_public_progress"` means the read
succeeded without eligible public progress, while `state: "read_error"` means
the exact task/items could not be read completely. Neither means the task has
stopped. Missing old-turn data is never replaced with a successor's progress.
`trace` retains its existing terminal behavior; it is not an unbounded backend
progress mode. Final answers and current questions/approvals retain their own
existing fields.

When the selected conversation is an unbound physical Codex terminal, targeted
Status may use the existing closed `/status` identity inspection if that pane
is safely idle. It can display a native status card to establish the exact
backend thread. It does not create a task or disturb a working or blocked
terminal. This routing inspection is separate from the diagnostic-only
`identify_foreground` action; see [automatic conversation routing](codex-cli-native-compatibility.md#automatic-conversation-routing-2026-10-10).

Explicit native inspection remains a closed action:
`native_inspect({terminal_id,inspection:"status"})`. It accepts no arbitrary
command and creates no AKK Turn, Session, receipt, monitor, or callback.

Native inspection and foreground identification are different contracts.
`native_inspect` inspects an already attributable native context. The explicit
Codex-only `identify_foreground` action is available for an otherwise safe but
ambiguous foreground and returns only the 30-second non-authorizing diagnostic
described above. `identify_and_send` consumes its observation without
releasing the terminal lock; callers must never cache a standalone proof and
use it as authority for a later action.

Codex native `/status` inspection requires an exact viewport of at least 80
columns so the complete UUID can be proven. Legacy terminal-scoped tasks
can bind from exact native acceptance afterward without running `/status` or
failing merely because the pane is narrow. Codex paginated read-contract candidates attempt a separate
closed `/status` binding before physical Send. If an exact callback Watch cannot
be prepared safely, AKK may prepare terminal-activity observation; the receipt states the actual mode and limitation. Claude inspection must prove,
parse, and dismiss one fresh Status panel and return to the same idle composer.
Other complete `x.y.z` agent versions remain callable with a compatibility
warning; incompatible runtime behavior fails or becomes uncertain rather than
being blocked by a version allowlist.

## Approval boundaries

Approval always requires the current exact prompt and explicit human intent.
Backend approvals use the exact pending interaction from fresh Status in the
same controller conversation. See the [CLI backend](codex-cli-native-compatibility.md)
and [Desktop interaction](codex-desktop-compatibility.md) guides. The prompt,
screen, and key boundaries below describe terminal approval.

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

Recovery is specific to the provider and original task. Use its exact saved ID
and the applicable actions below; do not substitute the latest conversation.

### Backend task recovery

For Codex CLI backend and Desktop tasks, use the original task's `watch_id`
from the originating controller; Recover, Renew, Close, and Retry Callback
also accept its Send-produced `turn_id`. `recover` reconciles
the original task and supervises eligible monitor work; `renew` verifies that
task before extending observation. `unwatch` stops observation while retaining
Send management, and `close` releases managed Send ownership without stopping
Codex. A standalone Watch uses Unwatch. `retry_callback` retries only a known
retryable notification with its original identity; select `notification_id`
when more than one is eligible.

These operations never select the latest task or fall back to a terminal.
Closed management cannot be reopened, and Recover does not extend deadlines
or resume an explicitly stopped Watch. For exact inputs, callback uncertainty,
and observation semantics, use the [backend task recovery reference](backend-task-recovery.md).

### Terminal recovery and diagnostics

The following terminal controls remain available when the corresponding
state makes them meaningful. `reconcile_binding`, `identify_foreground`, and
`repair_model_control` retain their physical-terminal requirements; backend
Recover does not replace them.

An idle coding-agent terminal can still belong to another AKK Store. A resolved
dispatch means its task settled; it does not release that Store's native-thread
authority. List reports this conflict and withholds managed Send. An exactly
associated Claude native conversation can carry its terminal's recovery action;
use that action's physical `terminal_id`, while retaining the native
`conversation_id` for the later ordinary Send.

The shared runtime stays at its existing configured location; recovery does not
move the runtime or delete temporary Stores. Automatic recovery is limited to
Stores explicitly created with `AKK_EPHEMERAL_STORE=1`, under a private, owned,
non-symlink `akk-*` directory inside the system temporary directory. Every
registered owner must be proven dead by its exact process incarnation, and the
native session, physical terminal, idle state, and settled work must still be
verified. A temporary pathname, elapsed time, or dead PID alone is insufficient.
Persistent Stores require the advertised explicit transfer. A newer writer
recording legacy authority preserves its incomplete owner coverage; later writes
cannot make that legacy authority eligible for automatic recovery.

There are two distinct binding-recovery operations:

- `agent_knock_knock_reconcile_binding({terminal_id,conflicting_session_id})`
  detaches one advertised stale binding in the current Store. It does not move
  another Store's authority or adopt the live thread.
- An advertised `transfer_store_authority` action uses
  `agent_knock_knock_reconcile_binding({operation:"transfer_store_authority",terminal_id})`.
  After explicit user confirmation, AKK rechecks the displayed authority and
  transfers eligible settled native-thread authority to this Host's Store.
  No coding-agent input is sent and no Turn is created. Refresh List before
  continuing with the original native conversation's newly advertised Send.

For legacy records whose previous Host/writer ownership cannot be proven, the
action requires `maintenance_acknowledgement`. Stop every Host and old writer
using the **source Store**, then explicitly confirm that condition and include
`maintenance_acknowledgement:true`. The controller must never prefill this
acknowledgement. An idle Claude/Codex prompt, completed task, resolved ledger, or
elapsed timeout is insufficient evidence that those writers have stopped.
Any observed live or unverifiable owner, unresolved work, or changed authority
still prevents transfer. If no transfer action is advertised, use the reported
owner/conflict diagnostics to resolve the source Host; do not delete a ledger,
clear Store files, guess a Session ID, or supply a private authority token.

| Command | Use |
| --- | --- |
| `/akk doctor` | Diagnose installation, Host, terminal, and coding-agent readiness. |
| `/akk models <terminal>` | Inspect one idle pane's exact native model and reasoning catalog. |
| `/akk repair-model-control <terminal>` | Clear one exact List-advertised stale Codex `/model` surface; never submit it. |
| `/akk set-model <terminal> <model> <effort>` | Consume that catalog once; Codex reports current and future defaults separately (Ultra stays current-only), while Claude Code is session-only. |
| `/akk approve <turn-or-terminal>` | Approve one current prompt after explicit review. |
| `/akk renew <turn> <minutes>` | Restart monitoring for one still-live stalled Turn without terminal input. |
| `/akk retry-callback <turn>` | Retry one persisted failed callback with its original identity. |
| `/akk close <turn>` | Ordinary managed-Turn Close releases AKK management without terminal input or stopping the coding agent; native lifecycle recovery has the exception below. |

Explicit terminal Close is the user's management escape hatch. It has priority over
broken deferred-transfer or handoff state, closes the selected Turn first, and
then best-effort releases only linked AKK metadata. Refresh List afterward; if
the agent is still working, a new Watch can observe it.

Closing an uncertain native new/resume transition is a separate recovery path:
it may clear an unsubmitted Composer and perform a guarded `/status` inspection
to establish the actual native identity. Follow that exact advertised recovery
action. Do not treat every terminal Close variant as a record-only operation.

An uncertain terminal mutation is not a retry instruction. Do not resend,
approve, cancel, or repeat Enter blindly. Inspect the exact pane and durable
Status, then use only the action currently advertised by AKK.

## Structured tool surface

The OpenClaw plugin and Host Adapter register the ordered semantic tool catalog.
Pi and DeepSeek Harness verify the Host Adapter capability handshake against
their actual registrations, so the tool count and names are derived from that
catalog rather than maintained as connector constants. The current catalog
includes list, watch, unwatch, list resumable threads, native inspect, model
options, repair model control, set model, permission options, set permissions,
identify foreground, identify and send, new thread, reconcile binding, resume
thread, status, send, respond, typed native interaction response, approve,
renew, recover, retry callback, cancel, and close. Model-facing mutations
contain semantic IDs and user content only.
Connector prereleases that pin an earlier AKK runtime retain the tool surface
documented by that connector release.
Selectors, pane routes, draft text, fingerprints, tokens, revisions, candidate
fences, and binding generations stay inside the trusted Host adapter.

For the full lifecycle, callback, identity, handoff, and persistence contract,
see the [Terminal Handoff Protocol](bidirectional-agent-protocol.md). For
configuration and recovery specific to OpenClaw, see
[OpenClaw Operations](openclaw-operations.md).

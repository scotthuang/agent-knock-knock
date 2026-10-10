# Codex Desktop support in AKK 0.14.0

AKK can discover an existing local Codex Desktop conversation, send a task to
its original Desktop owner, and monitor the exact native task for completion
or attention. It can notify and answer asynchronous questions in the same active
native task. It does not open a second CLI conversation from the same history.
Command/file approvals, blocking questions, session settings, and exact task interruption use that same original owner. Unsupported native request forms remain manual.

AKK 0.14.0 introduces these Desktop controls. See the [README](../README.md)
for the first-task workflow and [OpenClaw installation](openclaw-operations.md#choose-one-installation-path)
for packaged and optional source installation.

## Version and platform evidence

The reviewed application is macOS Codex Desktop `26.1002.52244`, build `13536`,
bundle ID `com.openai.codex`, installed as `/Applications/ChatGPT.app`. These
values come from the app's `Info.plist`, not the globally installed Codex CLI.
Its bundled Codex metadata identifies `0.162.0-alpha.2`; that embedded metadata
is not an app-server runtime handshake or a claim that every running process
uses that version.

A read-only audit on 2026-10-10 reconfirmed those installed bundle values.
[The runtime](../src/desktop-runtime.ts) currently reads that fixed application
path on Darwin and requires the correct bundle ID.
[The IPC client's write profile](../src/desktop-ipc-client.ts) requires both
the version and build to match exactly. This is **not a minimum version** or a
promise of compatibility with later builds. An unreviewed build may still
return a compatible read-only snapshot; that does not authorize native writes.

The app's own `LSMinimumSystemVersion=13.0` metadata is not an AKK-verified
minimum macOS version. No Desktop Linux/Windows or alternate installation-path
support is established. The private IPC handshake does not attest the running
owner's build, so an updated disk bundle with an older app still running remains
a compatibility limitation. The real task/interaction evidence below is dated
2026-10-09; the new [backend Recovery work](backend-task-recovery.md#validation-boundary)
has fast-regression coverage, not a new live Desktop proof.

## Capability boundary

| Operation | AKK 0.14.0 behavior |
| --- | --- |
| List | Default to persisted expanded sidebar membership; offer the broader saved catalog with explicit `desktop_view: "history"`; retain unconnected rows and support search, project filtering, and pagination |
| Status | Read a fresh snapshot from the exact local Desktop owner when available; report unknown live state when only metadata is available |
| Send | Verify a live, idle thread, persist a send intent, submit once to its original owner, and correlate native acceptance |
| Automatic monitoring | Retain a durable Watch for the accepted native task and reconcile uncertain acceptance without resending |
| Explicit Watch | Bind to one exact task already running in the selected Desktop conversation |
| Completion | Settle from the bound native task's terminal state and retain its result even if a later task starts |
| Asynchronous questions | Expose the question and options, notify the controller, and submit its explicit answer to the same active task |
| Blocking questions | Notify with all native questions and submit one complete typed answer to the exact pending request |
| Command/file approvals | Notify with the available current command or file preview; submit explicit accept-once or reject and confirm native item progression |
| Permissions | Apply Read Only, Default, or Full Access to this idle conversation and verify the effective policy |
| Model and mode | Read current settings; apply an explicitly requested model/effort and optional Plan/default mode; no model catalog is exposed |
| Cancellation | Interrupt the exact selected native task; an old task ID never cancels a newer task |
| Unwatch | Stop observation without cancelling or changing the Desktop task |
| Cold loading, resume, new conversation | Not supported by the Desktop adapter |

No Desktop operation types a slash command or uses terminal activity as exact
completion evidence. Existing terminal capabilities remain separate and retain
their previous checks.

## Find and select a conversation

Use `agent_knock_knock_list` through the controller Host. Select Desktop rows
from `conversations[]` using their title, project, and `conversation_id`;
`desktop_scan` carries catalog/pagination diagnostics. Raw CLI output also
retains `desktop_sessions[]` for operator compatibility. Desktop continues to
use its original IPC owner; backend-first CLI routing does not turn saved
Desktop history into a replacement CLI conversation.
The default `desktop_view: "sidebar"` follows persisted expanded sidebar
membership (`persisted_expanded_membership`): eligible pinned conversations
and members of expanded project groups, respecting supported saved layout
settings. It does not inspect the rendered screen, scrolling, per-window
temporary state, or a group's live Show More pagination. If the saved layout
is unsupported or unavailable, inspect the returned limitations; AKK does not
silently replace this view with all historical candidates.

Use `desktop_view: "history"` explicitly for the broader saved catalog,
including older or hidden conversations. Sidebar discovery and historical
discovery both retain unconnected candidates. Show those rows with their
connection state instead of reporting only conversations with Send enabled.

Narrow the result using `desktopSearch` for a title or path and
`desktopProject` for an exact project ID or absolute project directory.
`desktopLimit` bounds a page; pass the returned cursor as `desktopCursor` to
continue the same view and filters. A page is not the complete catalog.
`view` identifies the selected scope; `total_candidates` describes that view
after filtering. `history_candidates` counts the broader saved pool before
search filters. `sidebar_selection_scope: "persisted_expanded_membership"` identifies
the sidebar reconstruction; `sidebar_status` and `limitations` describe its
evidence boundary. `returned` and `live_count` describe only the returned page
(`live_probe_scope: "returned_page"`). Four live rows out of thirty
returned rows means twenty-six candidates are not proven live, not that only
four Desktop conversations were discovered.

Select the conversation using its title and project, then copy its complete
`desktop:v1:...` ID from List. This identity encodes the Codex home, host, and
native thread; it is independent of window position, display title, and the
current owner's temporary client ID. Do not construct it from a title, use a
terminal selector, or substitute a conversation with the same project.

Sidebar or historical membership does not mean a conversation is currently
loaded in Desktop. Some entries were created in CLI, some have an unknown
creator, and some no longer have a live owner. Membership uses saved Desktop
project and sidebar state, not an original-creator filter. Live capabilities
are checked separately.

If the chosen row has no verified live owner, open that exact conversation in
Desktop and refresh List. AKK does not load it implicitly or resume it through
CLI. Remote/cloud entries do not gain local write capability from catalog
metadata.

## Send and monitor

The structured tools use the Desktop conversation ID for selection and the
returned Watch ID for exact task monitoring:

```json
{ "tool": "agent_knock_knock_send", "arguments": {
  "conversation_id": "desktop:v1:...", "request": "Summarize this project's test setup."
} }
```

The controller supplies a stable message identity. Retain the returned
`desktop-watch:...` ID and query it with
`agent_knock_knock_status({watch_id})` if a callback is delayed. For a task
already running, use `agent_knock_knock_watch({conversation_id})`. Explicit
Watch requires an exact active native task; an idle or unknown conversation
does not create a best-effort activity Watch.

Equivalent CLI commands are:

```bash
agent-knock-knock list --desktop-view sidebar
agent-knock-knock list --desktop-view history --desktop-search 'older title'
agent-knock-knock status --conversation 'desktop:v1:...'
agent-knock-knock send --conversation 'desktop:v1:...' \
  --message 'Summarize this project.' --message-id 'one-stable-request-id' \
  --openclaw-session 'initiating-controller-session' --background
agent-knock-knock watch-terminal --conversation 'desktop:v1:...' \
  --openclaw-session 'initiating-controller-session'
agent-knock-knock watch-status --watch 'desktop-watch:...'
agent-knock-knock unwatch-terminal --watch 'desktop-watch:...' \
  --openclaw-session 'initiating-controller-session'
```

The examples contain placeholders: copy real IDs from List and Send/Watch.
Use a new message ID only for a genuinely new task. Repeating an ID recovers
its existing record rather than sending another task. A lost response or
uncertain receipt is not permission to retry with a different ID.

Conversation Status and task Status answer different questions. The former
reports the live conversation; the latter follows the original native task.
An idle conversation, a newer message, or a callback transport acknowledgement
does not by itself prove the selected task succeeded. A completion result may
be `completed`, `failed`, or `interrupted`; inspect the recorded outcome.

Asynchronous questions appear in `interaction_state` on fresh conversation or
Watch Status. The Watch sends a durable notification with the question and
options while the task continues working. A notification is not permission to
choose an answer: the controller refreshes Status, presents the question to the
user, and waits for their reply. It then refreshes Status and calls
`agent_knock_knock_respond_interaction` with the exact conversation or Watch,
interaction ID, and the advertised question/option IDs. Free-text answers are
also supported. Only `steer_current_turn` is supported; a completed task's
question cannot start another task.

The response is recorded before dispatch. Inspect later Status `response_state`
to recover its receipt without resending. The durable dispatcher deduplicates
repeated identical answers, but an expired or consumed Host offer does not
authorize another Respond call. A native acknowledgement is `sent`, not
`confirmed`; confirmation requires the matching accepted native answer in the
original task. An uncertain outcome is observed, never automatically replayed. Later Status
returns `response_state` so receipt recovery does not require resending an answer.
Answered questions disappear from the pending list. Undelivered reminders are
withdrawn when the question is answered or its task ends; an already delivered
notification cannot be recalled.

Blocking questions use the same response tool, with all advertised questions
answered together and no `delivery_mode`. Command/file approvals use
`agent_knock_knock_approve` with the exact conversation or Watch,
`interaction_id`, and `decision: "approve_once"` or `"reject"`. Refresh Status in
the same controller conversation before acting. Approval confirmation requires
the exact native command/file item to advance; a missing request or a completed
task alone is insufficient. Other native request forms remain manual.

## Settings and cancellation

`permission_options({conversation_id})` exposes `read-only`, `default`, and
`full-access`. `set_permissions({conversation_id,mode})` changes only this idle
conversation. Full Access is an ordinary option with no extra confirmation.
AKK verifies the effective permission profile, approval policy, reviewer, and
sandbox type before reporting `applied: true`; global defaults are unchanged.
For an idle conversation, `applies_to: "next_task"` reads resolved
`latestThreadSettings`. The app keeps `currentPermissions` from the last task
until another starts; during active work, permission inspection reports that
current task's actual policy instead.

`model_options({conversation_id})` reports the current model, reasoning effort,
and collaboration mode. The reviewed follower API has no model-list method:
`catalog_available` is false, not an empty or fabricated available-model list.
`set_model({conversation_id,model,reasoning_effort,collaboration_mode?})` accepts
an explicitly requested model ID. Optional mode is `plan` or `default`; omitting
it preserves the existing mode and custom instructions. Readback confirms the
effective settings, not model availability or account entitlement. Settings
changes require an idle conversation. Unknown outcomes are inspected, never
automatically replayed.

`cancel({watch_id})` targets the Watch's original native task.
`cancel({conversation_id,expected_native_turn_id})` uses the exact task ID from
fresh Status. Both use the native expected-turn interruption contract. An old
settled task returns its existing outcome without interrupting a newer task.
Cancellation may race with completion: report the observed native outcome,
not a promised interruption. `unwatch` only stops monitoring.

Desktop backend tasks also support `recover`, `renew`, managed `close`, and
manual `retry_callback` using their exact persisted task IDs, without terminal
fallback. Close ends Send management, while Unwatch leaves that management
intact. See [backend task recovery](backend-task-recovery.md) for deadline,
identity, callback retry and stopped-observation semantics.

## Protocol and persistence

OpenAI documents app-server threads, turns, and completion notifications in
its [app-server reference](https://learn.chatgpt.com/docs/app-server).
Those shared concepts explain the native task identifiers; the documented
app-server interface alone does not establish ownership of a conversation
already open in Desktop.

This adapter uses the app's private local IPC socket under the selected Codex
home. The reviewed route discovers the current thread owner, follows its
state stream, and submits through that owner. It validates socket ownership,
message shapes, peer identity, thread identity, revision freshness, pending
interactions, and the send receipt. Writes require the reviewed Desktop
version/build. This IPC surface is not an official stable third-party API;
an app upgrade may require another compatibility review.

Catalog reads copy supported SQLite database/WAL files to a private temporary
directory, validate the copy, and query it without opening the user's source
database through SQLite. AKK does not edit session databases or rely on an old
JSONL path for Desktop task state. Failed or changed catalog snapshots are
reported as incomplete evidence, not silently treated as an empty catalog.

Before sending, AKK persists the controller, target, request identity, and
submission intent. It then attempts one native submission. Recovery observes
native user-message/task evidence; it never replays a possibly sent request.
Watch state and callback outbox records survive an AKK process restart.
Callback retries use stable notification identity and bounded delivery
handling; an uncertain transport outcome remains uncertain rather than being
reported as delivery success.

The native send API has no atomic idle-and-send precondition. AKK checks a
fresh idle snapshot immediately before dispatch, but a human can start work
between that check and the app accepting input. This race can yield uncertain
task attribution. Do not operate the same conversation simultaneously when
you need an unambiguous handoff; inspect the native conversation and the saved
Watch instead of sending again. Reconnecting a follower may legitimately
advance the stream revision, so revision changes alone do not prove a new
task; owner, native task, input, and current state must agree.

## Evidence and limits

The implementation follows local read-only app/source inspection and a
dedicated Desktop proof on 2026-10-09. The proof sent a uniquely identified
benign message to the exact test thread, observed its native completion, and
the user confirmed the reply appeared in that same Desktop conversation.
A separate discovery pass retained previously missed unloaded/creator-unknown
candidates; the user confirmed the resulting five relevant conversations.
These observations establish the route and discovery strategy, not universal
support for every Desktop build, platform, or remote host.

The reviewed boundary does not cover Windows/Linux Desktop, cloud-hosted
threads, arbitrary installations of the app, automatic conversation loading,
automatic model catalog discovery, unsupported approval forms, or atomic
coordination with simultaneous human input. Completion generation and durable
delivery state must also be distinguished from successful delivery through an
external chat provider.

Development verification uses `npm run test:fast` plus relevant build and
architecture checks. The repository reserves full/release suites for an
actual publication gate; local development and installation do not authorize
those suites.

## Production-adapter verification — 2026-10-09

The 0.14.0 implementation was exercised against the reviewed macOS build,
using only the user's dedicated Desktop test conversation:

- The normal `list` command returned the live Desktop conversation alongside
  terminal rows. Exact thread selection and read-only conversation Status agreed.
- Two benign tasks were submitted to that same original Desktop conversation.
  One initially had unproven acceptance; its detached monitor later correlated
  the persisted client message with the native task and observed completion,
  without another submission.
- An explicit Watch added during the second task bound to the same native turn
  as the automatic Watch. Both retained the exact completed result.
- Repeating the first task's stable message ID returned the original Watch;
  the native latest-turn ID did not change.
- A local callback receiver exercised the existing OpenClaw `chat.send`
  transport path and acknowledged each Watch's stable idempotency key. Each
  Watch delivered one completion notification; subsequent reconciliation added
  none. This verifies local callback creation, dispatch, acknowledgement, and
  durable settlement. Real Gateway/WeChat delivery was not exercised.

`npm run test:fast` passed **2529 tests**, including Desktop protocol,
correlation, CLI/tool routing, persistence, manual-attention fixtures, and
existing terminal regressions. Build, architecture and refactor-evidence
validators passed without increasing architecture budgets. Full/release tests
were not run because this was an implementation round, not publication.
Those initial implementation tests did not exercise manual questions/approvals,
app restart during a task, unloaded-thread activation, or alternate app builds.
Later verification and the asynchronous-question change are recorded below.

The installed app bundle identifies the reviewed version. The private IPC
handshake does not attest the live owner's build; installations where the
running app and its on-disk bundle differ remain a compatibility boundary.

## Asynchronous-question repair — 2026-10-09

A dedicated-thread reproduction confirmed that Desktop stores asynchronous
questions on `agentMessage.delivery = "async"` with `questions`, while
`requests` can remain empty. The original adapter dropped these fields and
missed the notification. The repaired adapter reads both structures and
recognizes accepted native replies, including steering messages that later
materialize as canonical user messages.

The changed production semantic tools and compiled CLI were exercised against
the same reviewed Desktop build, without installing the patch:

- A choice question appeared in Watch Status and delivered one durable
  question notification. The advertised Green option was submitted through
  `respond_interaction`; exact native answer evidence confirmed the response,
  and the original task completed with Green.
- A free-text question appeared in conversation Status. Orchid was submitted
  to that exact conversation through the same tool, and the original task
  completed with Orchid. Later Status exposed the confirmed `response_state`.
- Repeating each answer recovered the same confirmed response record, with no
  additional task. Answered questions disappeared, and each task delivered one
  completion callback.

These two repair proofs used the production Host-profile callback transport
with a local receiver; this patch was not installed into the running Gateway
and no new WeChat delivery is claimed. The earlier Desktop completion proof
separately reached WeChat and was confirmed by the user. A preliminary native
PoC was also repeated before implementing the repair.

Fast regressions cover incomplete history, stale questions, owner/turn changes,
unknown dispatch outcomes, explicit retries after proven non-dispatch, response
recovery through Status, cross-Watch deduplication, and retirement of unsent
obsolete notifications. Partial history is unknown, not proof that a question
was answered. Native async-answer acknowledgement and exact answer confirmation
remain separate states. That repair alone did not enable approvals, blocking responses, or settings.
The subsequent implementation below adds those controls; cold loading remains unsupported.

The final repair check passed `npm run test:fast` (**2622/2622**), including its
build, plus `npm run validate:architecture`, `npm run validate:refactor-evidence`
and `git diff --check`. Architecture budgets were unchanged. Full/integration
and release suites were not run under the repository's development test policy.

## Native controls implementation — 2026-10-09

The production semantic tools, compiled CLI, durable response store, and Watch
monitor were exercised against the same reviewed Desktop build in the dedicated
test conversation. This round did not rely on direct proof-script responses:
all task sends, answers, approvals, settings changes, and cancellation used the
AKK product entry points.

Eight native tasks verified:

- Read Only command approval accepted and execution observed; a separate command
  rejected, with its proposed file demonstrably absent.
- File approval accepted and the exact expected file contents observed.
- Plan-mode blocking input answered both native questions in one typed response;
  native answer records and the original task's final result agreed.
- Default-mode asynchronous input answered in the same running task, preserving
  the earlier async-question repair.
- Default permission mode allowed a benign workspace write; Full Access allowed
  a benign write to a dedicated directory outside that workspace. Native task
  permissions and file contents confirmed both effects.
- An exact Watch cancelled its own active task. The native state and callback
  reported `interrupted`; repeating cancellation for that settled native ID
  returned its existing outcome without issuing another interruption.

Seven tasks completed and one was intentionally interrupted. Each produced one
settlement callback; all five approval/question interactions also produced
attention notifications and confirmed response records. This round used the
production Host-profile callback transport with a local receiver, not a new
Gateway/WeChat delivery test. Earlier user-confirmed WeChat evidence remains
separate.

The same product controls changed the model and reasoning effort, switched
Plan/default mode, and verified the effective collaboration settings. They then
restored the original model, effort, mode, and permission preset. Test files were
removed after verifying their exact contents; the conversation was left idle
and its test monitors exited. No unrelated conversation was used.

One real readback issue was corrected during this verification: idle setting
updates replace `latestThreadSettings`, while `currentPermissions` remains the
last task's applied policy. AKK now distinguishes next-task settings from active
task permissions instead of incorrectly timing out on an already-applied change.
Regression coverage preserves both native fields and rejects partial preset
matches. Model confirmation likewise uses the effective collaboration tuple,
not only a top-level model cache.

Limitations still include automatic new/cold-resume operations, model catalog
and account-availability discovery, unsupported native request forms, alternate
Desktop builds/platforms, and atomic coordination with simultaneous human input.
No package publication or local installation was performed in this round.

Final checks passed `npm run test:fast` (**2662/2662**, including the build),
`npm run validate:architecture`, `npm run validate:refactor-evidence`, Skill
synchronization/validation, and `git diff --check`. Architecture budgets were
unchanged. Full/integration/release suites were skipped under the development
test policy. An additional native settings check confirmed that changing only
model/effort preserves the current mode, then restored the original settings.

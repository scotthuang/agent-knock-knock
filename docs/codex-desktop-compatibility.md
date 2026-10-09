# Codex Desktop support in AKK 0.14

AKK can discover an existing local Codex Desktop conversation, send a task to
its original Desktop owner, and monitor the exact native task for completion
or manual attention. It does not open a second CLI conversation from the same
history. Desktop approval and question answering are outside this first version.

The reviewed application is macOS Codex Desktop `26.1002.52244`, build `13536`,
bundle ID `com.openai.codex`, installed as `/Applications/ChatGPT.app`. These
values come from the app's `Info.plist`, not the globally installed Codex CLI.
Its bundled Codex metadata identifies `0.162.0-alpha.2`; that embedded metadata
is not an app-server runtime handshake or a claim that every running process
uses that version.

## Capability boundary

| Operation | Desktop v1 behavior |
| --- | --- |
| List | Merge the local Desktop catalog and supported Codex state metadata; retain unloaded and creator-unknown candidates; support search, project filtering, and pagination |
| Status | Read a fresh snapshot from the exact local Desktop owner when available; report unknown live state when only metadata is available |
| Send | Verify a live, idle thread, persist a send intent, submit once to its original owner, and correlate native acceptance |
| Automatic monitoring | Retain a durable Watch for the accepted native task and reconcile uncertain acceptance without resending |
| Explicit Watch | Bind to one exact task already running in the selected Desktop conversation |
| Completion | Settle from the bound native task's terminal state and retain its result even if a later task starts |
| Questions and approvals | Notify that manual attention is needed; the user responds in Desktop |
| Unwatch | Stop observation without cancelling or changing the Desktop task |
| Cold loading, resume, new conversation, cancellation, model or permission changes | Not supported by the Desktop adapter |

No Desktop operation types a slash command or uses terminal activity as exact
completion evidence. Existing terminal capabilities remain separate and retain
their previous checks.

## Find and select a conversation

Use `agent_knock_knock_list` through the controller Host. Desktop rows are in
`desktop_sessions[]`; `desktop_scan` carries catalog/pagination diagnostics.
Narrow the result using `desktopSearch` for a title or path and
`desktopProject` for an exact project ID or absolute project directory.
`desktopLimit` bounds a page; pass the returned cursor as `desktopCursor` to
continue the same query. A page is not the complete catalog.

Select the conversation using its title and project, then copy its complete
`desktop:v1:...` ID from List. This identity encodes the Codex home, host, and
native thread; it is independent of window position, display title, and the
current owner's temporary client ID. Do not construct it from a title, use a
terminal selector, or substitute a conversation with the same project.

Catalog membership does not mean a conversation is currently loaded in
Desktop. Some entries were created in CLI, some have an unknown creator, and
some no longer have a live owner. Keeping these rows is deliberate: filtering
only by creator or currently loaded owners can hide a conversation that a
person still sees in Desktop. Live capabilities are checked separately.

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
agent-knock-knock list --desktop-search 'project or title'
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

Questions and approvals produce manual-attention notifications while the
Watch continues. Respond in Desktop. Desktop v1 never turns an attention
notification into an executable answer or approval offer.

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
approval or question responses, permission/model changes, or atomic
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
Manual questions/approvals, app restart during a task, unloaded-thread
activation, and alternate app builds were not exercised live.

The installed app bundle identifies the reviewed version. The private IPC
handshake does not attest the live owner's build; installations where the
running app and its on-disk bundle differ remain a compatibility boundary.

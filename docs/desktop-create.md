# Create a Codex Desktop conversation

Available starting in AKK **0.14.5**. It adds `agent_knock_knock_desktop_create` and the
`desktop-create` CLI command. Existing Desktop Send still targets a conversation
that already exists; terminal `new_thread` still replaces the context of its
selected terminal. These operations are separate.

## Use it from your controller

Ask, for example:

> Create a conversation in my Desktop project “my-project”, review its tests,
> and tell me when the review is done.

The controller calls the new tool with the exact project name or native project
ID and, optionally, the first task:

```json
{
  "project": "my-project",
  "title": "Review project tests",
  "request": "Review the tests and summarize the gaps. Do not modify files."
}
```

To create outside Desktop projects, omit `project`. To create a blank conversation
without starting work, also omit `request`:

```json
{
  "title": "New research conversation"
}
```

A first task is optional in both cases. AKK creates no hidden seed task. If a
request is supplied, it is sent only after Desktop has loaded the same new
conversation and its live owner is verified.

| Parameter | Meaning |
| --- | --- |
| `project` | Exact existing Desktop project name or native project ID; omitted means no project membership |
| `cwd` | Existing working directory; use an absolute path in tool calls |
| `title` | Optional conversation title; defaults to `AKK 新会话` |
| `request` | Optional first task, sent through the verified Desktop owner |
| `agentHardTimeoutMinutes` | First task's monitoring hard lifetime; explicit value, then plugin configuration, then 720 minutes |
| `operation_id` | Continue one previous creation; supply this field alone |

For a project with one local root, AKK uses that root by default. For multiple
roots, supply `cwd`. A supplied directory must resolve inside one of that
project's roots; an ambiguous project name or mismatched directory is rejected.
AKK checks native project membership separately from the working directory.

Without a project or `cwd`, AKK creates a private working directory at
`~/.agent-knock-knock/workspaces/desktop/<operation-id suffix>`, using the last
16 hexadecimal characters of the stable operation ID. This avoids assigning
an unspecified task to whichever repository happens to be open.

## Read the receipt and continue the same operation

The Host derives a stable `operation_id` from the controller session, its
conversation incarnation, and the tool call. Replaying the same invocation does
not create another conversation. The same ID with different creation parameters
is rejected.

Keep the returned ID, `conversation_id`, and any `watch_id`. Creation readiness
and first-task acceptance are separate:

- `status: "ready"` means the new conversation has a verified Desktop owner.
  It does not mean its optional task has finished or even been accepted.
- `request_state: "accepted"` means the first task has native acceptance evidence;
  `watch_id`, `native_turn_id`, and `task_status` describe that exact task.
  No `request_state` is returned when creation had no request.
- `prepared` / `creating` means creation is still in progress; an active worker
  sets `operation_in_flight`. `created` / `opening` means Desktop ownership is
  not yet confirmed. `uncertain` means a
  creation or handoff result could not be confirmed; it is not permission to
  repeat creation. `created: null` likewise means unknown, not “nothing happened”.
- `request_state: "not_sent"` or `"uncertain"` must not be reported as successful
  task delivery merely because the conversation was created.

For an incomplete operation, call `agent_knock_knock_desktop_create` with only
its returned `operation_id`. AKK uses the stored inputs, callback route and
original task identity. It can continue loading the known thread or reconcile
its first-task receipt; it never creates a replacement thread or replays an
uncertain task. An unknown or foreign operation ID is rejected. Inspect an
explicit `failed` result's error before deciding what to do next.

When the response provides an automatic Watch, use that Watch for Status and
completion; do not add a duplicate Watch. Its default hard deadline is 720
minutes. Callback acceptance proves delivery to the controller Host, **not**
delivery to WeChat or another downstream channel. See
[backend task Recovery](backend-task-recovery.md) for task-monitoring operations.

## How creation reaches Desktop

Desktop must already be running locally as the same OS user as AKK. On a
supported macOS build, AKK:

1. Connects to a temporary app-server process using the installed Desktop app's
   bundled backend and creates only thread metadata, with the requested project
   identity and working directory. No model turn or bootstrap message is sent.
2. Closes that temporary backend and opens the native `codex://threads/...` link
   for the new UUID. **This can navigate the Desktop UI to the new conversation.**
3. Confirms that Desktop owns the same UUID and working directory. Creation in a
   separate backend alone does not satisfy this check.
4. If requested, uses Desktop IPC to send the real first task and attaches the
   existing exact-task Watch. No task runs in the temporary creation backend.

The metadata request specifies workspace-write sandboxing and on-request
approvals, but Desktop can apply different settings when it takes ownership.
The live acceptance run observed **Read Only / on-request** after handoff.
Review effective permissions in Desktop; creation does not promise write
access or enable Full Access. Account/model defaults are inherited. Existing
conversations and global defaults are not changed. If the thread acquires another task or pending interaction
before the first-task dispatch, AKK refuses to send into it rather than silently
joining unrelated work.

## Compatibility and evidence boundary

AKK 0.14.9 adds macOS Desktop `26.1007.71326`, build `20398`,
with bundled backend `0.162.0-alpha.17.2`. The 2026-10-18 dedicated test verified
projectless creation, the original Desktop owner, first-task acceptance and
completion of that exact native turn. An initially uncertain acceptance was
resolved by observation without another Send. Effective model/effort and
permission updates, command/file approvals, blocking/asynchronous answers and
exact cancellation were also verified in the isolated test conversation.
Attention/completion callbacks were accepted once by a local receiver; this is
not a new external-channel delivery claim. See the
[validation record](codex-desktop-compatibility.md#build-20398-validation--akk-0149)
for the exact effects and remaining limits.

Creation requires one coherent application version/build/bundled-backend
combination. A later version is not implicitly supported, and a metadata
creation receipt cannot substitute for a live Desktop owner. The private IPC
is not a stable public third-party interface; alternate installation paths,
Windows/Linux and a running owner different from the installed bundle remain
outside the verified boundary.

The 0.14.5 profile enables new-conversation creation and Desktop Send on
macOS Desktop `26.1007.30912`, build `20156`. It preserves exact owner and task
checks for Status/Watch. AKK 0.14.7 adds command/file approvals with explicit
allow-once or reject decisions. AKK 0.14.8 adds
blocking and asynchronous question replies through the advertised Respond
action. Permission/model changes and cancellation remain unavailable on this
build; handle those actions in Desktop. Approval and question replies do not
change the permissions inherited when the conversation was created.

The question changes passed dedicated real Desktop choice, free-text, and
two-question validation on 2026-10-14, with exact native answer evidence and
original-task completion.
Local callback acceptance does not establish external chat-channel delivery.

The existing full native-control profile for Desktop `26.1002.52244`, build
`13536`, is unchanged; it does not enable this new creation workflow. These are
per-capability profiles, not a minimum version or future-version promise.
[Desktop compatibility](codex-desktop-compatibility.md) is the authoritative
operation matrix.

On 2026-10-13, the actual semantic tool and built CLI created a projectless blank
conversation and a conversation in an existing test project. Desktop owned both
exact UUIDs; the blank conversation retained zero turns. The optional first
task ran through Desktop IPC, completed with the expected marker, and its exact
Watch delivered one accepted callback to an isolated local receiver. The initial
Send receipt was awaiting acceptance; the monitor later confirmed the native
task by its client message ID without resending. No external chat channel was
used, so this is not a WeChat delivery claim.

Creation authorizes loading only the new thread recorded by that operation.
It does not add arbitrary cold loading/resume of old Desktop history, create
Desktop projects, or replace a user's existing conversation. There is no
terminal/UI-input fallback when creation or task acceptance becomes uncertain.

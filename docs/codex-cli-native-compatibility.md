# Codex CLI shared-backend control

AKK can control an existing Codex CLI conversation through its local shared
app-server. This route needs neither tmux nor Herdr, and does not type into the
terminal. The original CLI displays the same tasks, questions, approvals and
answers.

## Discovery and use

Ask your controller to call AKK List. `codex_cli_sessions` contains loaded main
CLI threads from configured local Codex homes. Choose the returned
`conversation_id` by its title and working directory. The opaque ID includes
the backend home and exact thread ID; a directory or title alone is never a
target identity. Child-agent threads and unloaded histories are excluded.

The existing tools accept this native conversation ID:

| Tool | Native CLI behavior |
| --- | --- |
| List | Discover currently loaded main CLI threads, with backend version and activity flags |
| Status / native Status | Read exact task state and results; refresh pending approvals and questions |
| Send | Send one task to an idle thread, persist its submission, and create an exact task Watch |
| Watch | Attach to the uniquely active native task, including a task started manually in the CLI |
| Watch Status / Unwatch | Refresh the original task, or stop observation without stopping Codex |
| Approve | Accept once or reject a current command or file approval by its interaction ID |
| Respond Interaction | Answer blocking or asynchronous questions using advertised question and option IDs |
| Permission Options / Set Permissions | Read or set Read Only, Default, or Full Access for the current thread |

No additional confirmation is required by AKK for Full Access. Permission
updates use `thread/settings/update`, then check the effective setting. They
do not create a new task or modify global defaults. Send itself does not change
permissions.

For example, in a controller chat: “Find my Codex conversation for this project,
set its permissions to Default, then send this task and tell me when it finishes.”
The controller uses List, Permission Options, Set Permissions, then Send with
the returned native ID. Existing terminal and Desktop IDs retain their own
adapters and capabilities.

Operators can inspect only this inventory with:

```sh
agent-knock-knock codex-cli-list
agent-knock-knock status --conversation '<conversation_id from List>'
```

For native Watch and response commands, use the exact returned Watch or
interaction ID. Watch IDs can be UUIDs or deterministic submission hashes;
they are opaque, not values to construct.

## What the evidence means

List uses read-only discovery. `active_flags` can report waiting for approval or
input, but List does not subscribe to every conversation's requests. Its
`interaction_requests_scanned=false` and null pending count are not proof that
there are no questions. Status subscribes to the selected, already loaded thread
to retrieve current requests without terminal input.

A successful send is confirmed by the native thread, accepted turn and exact
client-message ID. An RPC acknowledgement alone is insufficient. AKK briefly
waits for newly accepted history to materialize; if still uncertain, the
persisted Watch continues observation and the send is never automatically
replayed. A repeated message ID returns the same durable task.

Completion means the specific native turn has settled and its items have been
read completely. It does not mean that the latest terminal screen looks idle,
or that another later task has finished. The callback outbox records delivery
attempts and does not blindly retry an ambiguous transport result.

Approvals and answers bind to the current thread, turn, item and stable
interaction ID. A reconnect refreshes connection-local request IDs. Responses
are persisted before dispatch. `sent` means the response was dispatched;
`confirmed` includes the returned evidence of exact asynchronous answer history
or subsequent native task progress. These evidence labels do not imply that
every response has an independent server acknowledgement.

A response proved `not_sent` may be explicitly requested again after refreshing
the same question; AKK revalidates it and records the new attempt. This does not
permit automatic replay of `sent` or `uncertain` responses.

## Compatibility and limits

The verified local combination is macOS Codex CLI **0.160.0** connected to shared
app-server **0.162.0**. AKK validates the live protocol and backend home instead
of requiring matching frontend/backend version numbers or an exact version
allowlist. Unsupported methods or changed response shapes fail for that
operation with a diagnostic; unknown state never becomes task completion.

The permission update API is experimental. Backends may evolve, so action-time
contract checks and the actual effective settings remain necessary.

### Implementation verification (2026-10-09)

The production CLI adapter, native monitor and durable callback outbox were
exercised against the version combination above in one isolated CLI launched
with the user's existing `mycodes --remote` wrapper. The shared daemon and
other working conversations were not restarted. Raw protocol calls were used
only to prepare the test thread's workspace, model and Plan mode; the actions
below used AKK's public CLI commands.
The original CLI display contained all seven task-result markers, confirming
that these were tasks in the attached CLI conversation.

| Path | Observed result |
| --- | --- |
| Discovery and Status | Selected the dedicated main thread by exact ID and read its real task state |
| Send and automatic Watch | Accepted client-message ID bound to the exact native turn; repeated message ID did not create another turn |
| Completion and interaction callbacks | Production Host-profile transport acknowledged durable notifications; each tested completion delivered once |
| Explicit Watch / Unwatch | Attached to the already active turn; stopping that Watch left the native task running |
| Command and file approval | Exposed exact pending request, accepted it, and observed the same task finish |
| Blocking / asynchronous question | Exposed native question and option IDs, sent the chosen answer, and observed the same task finish with that answer |
| Permissions | All three presets read back correctly without a new turn; Full Access executed a write outside the test workspace |
| Monitor interruption | Stopped only the test monitor; host reconciliation recovered the original task's completion and delivered its callback once |

These implementation tests used a local Host-profile callback receiver. The
earlier PoC separately verified the existing OpenClaw transport through WeChat,
including user confirmation; a new WeChat delivery is not claimed by this run.
Protocol rejection, uncertain sends/responses, reconnect behavior and callback
lease recovery are also covered by fast regression tests. Network approvals,
multiline answers and rejection decisions have contract-level coverage; they
were not separately repeated against the live backend in this run. The full
and release test tiers are deferred to an actual publication under repository
policy. Final `npm run test:fast` passed **2,588/2,588** tests, including the build
and skill consistency check. `npm run validate:architecture` passed with no
import cycles, no hard-limit violations and no increase to the existing
complexity budget.

Only a CLI actually connected to a compatible shared backend appears in this
inventory. An embedded CLI backend does not become discoverable merely because
its history is readable. AKK does not restart Codex, switch a running CLI to a
different backend, or load an absent thread as a replacement session. The
existing tmux/Herdr route remains available for applicable terminal sessions.

This adapter does not add new-thread, resume-thread, model-change or interrupt
operations. Async answers target the still-active task; queued answers after
that task ends are not supported. Standard command/file approvals, Plan-mode
blocking questions and active-turn async questions are covered; specialized
MCP ownership verification is outside this adapter.

Official protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

# Codex CLI shared-backend control

AKK can control an existing Codex CLI conversation through its local shared
app-server. This route needs neither tmux nor Herdr, and does not type into the
terminal. The original CLI displays the same tasks, questions, approvals and
answers.

AKK 0.14.0 introduces this direct adapter. See the [README](../README.md) for
the first-task workflow and [OpenClaw installation](openclaw-operations.md#choose-one-installation-path)
for packaged and optional source installation.

## Discovery and use

Ask your controller to call AKK List. Its `conversations[]` collection includes
loaded main CLI threads from configured local Codex homes, supported physical
terminals, and Desktop candidates. Choose the returned `conversation_id` by
its title and working directory. Raw CLI output retains `codex_cli_sessions[]`
and the other provider arrays for diagnostics; they are not extra conversations
to present again. The opaque ID includes
the backend home and exact thread ID; a directory or title alone is never a
target identity. Child-agent threads and unloaded histories are excluded.

The existing tools accept a listed native conversation ID. The table describes
the shared-backend capabilities; terminal fallback retains its own evidence
and limitations:

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
adapters and capabilities; callers use the advertised operation targets.

Operators can inspect only this inventory with:

```sh
agent-knock-knock codex-cli-list
agent-knock-knock status --conversation '<conversation_id from List>'
```

For native Watch and response commands, use the exact returned Watch or
interaction ID. Watch IDs can be UUIDs or deterministic submission hashes;
they are opaque, not values to construct.

## Automatic conversation routing (2026-10-10)

For conversation operations, select the conversation and requested action,
not a transport. The shared routing policy covers Status, Send, Watch,
native inspection, permissions, approvals and questions, and capability checks
for model and lifecycle operations. AKK prefers a compatible, reachable shared backend when it
proves that backend thread is the selected live conversation. Existing opaque
`codex-cli:v1:...` and `terminal:v...` IDs remain accepted; the Host tools also
accept a terminal ID as `conversation_id` for these operations.

A physical terminal and a backend thread are coalesced only with exact current
thread identity, the verified Codex home of the live process, and the physical
terminal/process incarnation. A configured default home, matching cwd, title,
launch `resume` UUID or frontend version alone does not establish that link.
Home evidence comes from the observed process and its open resources, including
the Codex arg0 lock when available. Missing or conflicting evidence leaves the
representations separate. `terminal_aliases[]` records proven associations;
`terminal_controls[]` retains their managed Turns, recovery and terminal-only
actions inside the same conversation row. These nested controls are not extra
tasks or permission to bypass their existing checks.

List does not type into terminals. A targeted conversation operation, including
ordinary Status, can use the existing advertised idle-only `/status` inspection
to discover a missing paginated-thread identity before choosing the backend.
Codex renders this as a visible native status card; it creates no user task.
The inspection must retain the same exact pane, process, home and thread and
pass its existing empty-Composer and prompt checks. It never interrupts a
working or blocked terminal to discover identity. Without fresh proof, AKK
retains the eligible terminal route rather than guessing a backend thread.
No cached UUID, startup command or latest same-directory history can replace
fresh proof. The public backend currently exposes loaded thread IDs but no
terminal PID-to-current-thread mapping. This inspection is not an arbitrary
slash-command interface and cannot target another pane.

Backend unavailability established before dispatch may select an eligible
terminal route. A native ID requires a unique, freshly proven physical alias
for fallback; AKK does not choose arbitrarily between multiple matching panes.
A busy thread, pending approval/question, identity conflict or invalid protocol
response is not treated as permission to bypass the backend through terminal
input. A send's stable message identity pins its selected route; failures or
uncertain outcomes after selection never trigger another transport attempt.
Existing submission ledgers also retain their original route across upgrade.
A replayed Send receipt is the original submission observation, not a fresh
completion check. Use Status with the returned task/Watch ID for current state.
Read the returned routing and delivery fields: physical Enter dispatch still
does not prove native task acceptance or an exact completion callback.

Backend task recovery supports `recover`, `renew`, `close`, `unwatch`, and
`retry_callback` using the exact returned task/Watch ID. Close releases Send
management; Unwatch only stops observation. See [backend task recovery](backend-task-recovery.md)
for ownership, original-task reconciliation and callback delivery boundaries.

An existing `watch_id` stays bound to its original native task or terminal
observation. Answers and approvals use the exact current action from that
Watch or conversation's Status; they are not migrated between transports.
Permission reads and changes prefer the backend. Approval and question replies
use the exact interaction advertised by fresh Status; terminal request IDs and
fingerprints are not translated into backend requests. Model inspection/change,
Ctrl-C cancellation, and terminal binding/menu recovery can retain their
terminal path only where that exact terminal advertises the capability.
New/clear/resume and resumable-thread listing for paginated Codex 0.158+ remain
unsupported by both paths; switching to a terminal does not enable them.
An unsupported backend operation is not a reason to create a replacement CLI
or mutate another thread. Desktop continues to use its original IPC owner.

The routing changes have isolated regression coverage for exact association,
rejected weak identities, preflight fallback, pinned send routes, receipt
normalization, and actual unified List output passing through compact Host
projection into semantic conversation operations. These use fixtures and local
recording relays. They are distinct from the real backend tests dated
2026-10-09 below: this change does not claim a new live Send, Watch or callback
verification. Normal development validation uses only the repository's fast
test tier; full/release suites remain publication gates.

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

| Evidence | Scope |
| --- | --- |
| Live-tested combination, 2026-10-09 | **macOS: Codex CLI 0.160.0 + shared app-server 0.162.0**; production-adapter operations and limits are recorded below. |
| Additional targeted live proof, 2026-10-10 | **macOS: Codex CLI 0.162.1 + shared app-server 0.162.1**. Verified public Status progress while a task was in progress through the running OpenClaw plugin, an actual 720-minute Send deadline, one isolated local completion acknowledgement, and repeated Send retaining the original task/deadline. No new WeChat delivery or full native-operation matrix is claimed. |
| 0.14.2 compatibility review, 2026-10-10 | **macOS: Codex CLI 0.162.1 + shared app-server 0.162.1**. Expanded dedicated-session validation, native UI fixes and retained limits are recorded in the [operation matrix](codex-0.162.1-compatibility.md#verification-record). |
| Runtime admission | A loaded main CLI thread, the selected local Codex home, valid stable `x.y.z` backend metadata, and the required live protocol shapes/methods. There is **no established numeric minimum** or exact version allowlist for direct control. |
| Platform evidence | The live proof was on macOS. It does not establish a Linux/Windows direct-control validation matrix. |

The [native RPC adapter](../src/codex-native-client-rpc.ts) selects
`read_contract` compatibility in the [app-server client](../src/codex-app-server-read-client.ts).
AKK checks backend identity and each operation's protocol contract instead of
requiring frontend/backend version equality. A valid version string alone does
not establish support. Unsupported methods or changed response shapes fail for
that operation with a diagnostic; unknown state never becomes task completion.
Prerelease version suffixes do not meet the stable version syntax check.

The additional **0.162.1/0.162.1** proof above is limited to the stated
operations; the [0.14.2 compatibility review](codex-0.162.1-compatibility.md)
records the subsequent native UI/protocol review and its separate verification
matrix. Neither record establishes a numeric minimum. A thread's `cliVersion`
is creation metadata, not proof of the currently attached frontend's executable
version. The terminal TUI's [audited version pairs](codex-0.162.1-compatibility.md#version-and-route-boundaries)
govern a different adapter and must not be used as the direct-control version
matrix.

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

The 2026-10-10 documentation audit rechecked the retained local evidence
manifest and all seven proof-file hashes. It confirmed the version pair above;
those private artifacts are not shipped with the package. The native
RPC/client/snapshot source hashes still matched; task-service and CLI routing
code have since changed. These historical proofs therefore do not certify the
new Recover/Renew/Close/Retry Callback implementation. Its current validation
boundary is recorded in [backend Recovery](backend-task-recovery.md#validation-boundary).

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

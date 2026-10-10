# Codex CLI 0.162.1 compatibility

AKK 0.14.2 adapts the Codex CLI 0.162.1 frontend and reviews its shared
app-server contract. This is an operation-specific compatibility review, not a
new numeric minimum or a promise that future Codex versions use the same UI.
The [CLI direct-control guide](codex-cli-native-compatibility.md) describes the
separate shared-backend route, which does not need tmux or Herdr.

## Native status and error contract

Codex changed the `/status` informational usage link from
`https://chatgpt.com/codex/settings/usage` to
`https://chatgpt.com/settings/usage`. AKK previously accepted only the old
complete line. A real 0.162.1 inspection dispatched `/status` once and displayed
the correct native session, but AKK could not prove the fresh complete result
because its closed card parser rejected that new line.

The recorded error was that Enter had been dispatched exactly once without a
proven fresh exact result. The controller's later JSON parse error was
secondary: the semantic tool had thrown that failure and the Host presented a
plain-text error. It was not evidence of malformed app-server JSON.

Both complete-card parsing and bounded clipped-history recovery now accept
the two exact official informational lines. They still reject unknown prose,
duplicate or malformed identity fields, stale cards, changed versions and
unproven closing surfaces. The usage link is never identity evidence.

Native-inspection execution failures now retain JSON `content` and `details`
with `isError: true`, `error_code: "AKK_NATIVE_INSPECTION_FAILED"`, a sanitized
diagnostic, `do_not_retry: true` and `safe_to_retry: false`. A failure to parse
the result does not prove that terminal input never happened. Parameter
validation and abort semantics, CLI exit status and stderr remain unchanged.

## Terminal interaction contracts

The 0.162.1 macOS asynchronous question surface uses `⇧←`/`⇧→` and `⌃]`
instead of the older textual Shift/Control hints. AKK uses a distinct exact
profile, including complete footer and question-identity checks. Older
frontends keep their own grammar; mixed, clipped or unknown keymaps never
authorize input. Native status may recognize closed queue hints as display
information without granting answer authority.

The model and built-in permission menus receive an exact 0.162.1 profile.
Model inspection retains the mandatory single current-model marker and exact
scope footer; a missing default badge does not invent a persisted default.
Permission selection retains same-thread, same-catalog and effective-result
checks, including the native Full Access confirmation. Backend per-thread
permissions and terminal menu actions remain separate capabilities.

The dedicated live check also found a second UI change: Full Access confirmation
moved from an inline picker to a centered 72-column overlay with transcript and
composer content still visible behind it. Its warning and choices did not
change. The old tail-only parser correctly stopped before confirming because
it could not prove that new surface. The 0.162.1 adapter now recognizes the
exact version-bound styled rectangle, full warning, both choices and selected
row, while retaining fresh-frame and terminal identity checks. Ambiguous
background column widths or control sequences still fail closed.

Blocking `request_user_input` has its own 0.162.1 v5 profile. Its multi-question
free-text footer uses the exact `⌃p / ⌃n change question` spelling; the
canonical Other option's notes description remains unchanged. The reviewed
ordinary option, free-text, notes and unanswered-confirmation upstream snapshots
are unchanged from 0.160.0. Regressions cover the new wrapped footer,
profile-bound interaction IDs and rejection of secrets, mixed keymaps and
changed submit instructions. This source/regression evidence is separate from
the live question paths listed below.

## Backend protocol review

The retained official binaries generated 875 experimental TypeScript schema
files for 0.160.0 and 888 for 0.162.1: 13 added, 23 changed and none removed.
The complete schema sets are not identical. The reviewed core schemas for
initialization, thread identity/status, loaded-thread listing, thread reads,
paged turn/item reads, resume, settings updates, steering, command/file
approval, user input, model listing and interruption are byte-identical.
Schema or source agreement does not replace runtime response validation or
prove that a mutation succeeded.

The additive changes include `Turn.rootTurnId`, optional `parentTurnId` and
`rootTurnId` on turn start, `MessagePhase.partial_answer`, and model/effort
metadata on sub-agent activity. Existing parsers tolerate these additions
without treating them as new authority.

Regression coverage preserves the exact selected turn when sibling turns
share a `rootTurnId`. An `agentMessage` with `phase: "partial_answer"` is not a
completed task or a final answer. Native completion state, complete item reads
and the original turn ID remain necessary for final callbacks. Partial answers
also remain outside the commentary-only public progress projection. Multiline
asynchronous question titles, URLs and answers retain their complete native
question identity and are encoded through the existing structured answer
envelope, with no automatic duplicate response.

The upstream resume path in both reviewed versions requires persisted history.
A newly loaded, idle, empty thread may expose live metadata before any rollout
exists. AKK preserves that verified identity as
`history_state: "unmaterialized"`, but does not advertise Send or permission
actions that require a native subscription. Status and native inspection can
return the fresh idle metadata with
`subscription_state: "unavailable_unmaterialized_history"` and
`observation_error: "native_subscription_unmaterialized"`. Its
`interaction_requests_scanned: false` and null pending-interaction count mean
requests were not scanned, rather than proving that no question or approval
exists. This diagnostic fallback requires the exact missing-rollout condition
and a fresh same-thread idle/empty read; it does not accept unrelated failures.

## Version and route boundaries

| Route | Compatibility rule |
| --- | --- |
| Direct shared-backend CLI | Live identity and method/response contracts govern availability; no exact-version allowlist or numeric minimum is introduced. |
| Terminal paginated interaction writes | Add only the audited **frontend 0.162.1 / app-server 0.162.1** pair. Existing older audited pairs remain; 0.162.1/0.162.0 and 0.162.1/0.162.2 are not admitted as write pairs. |
| Terminal native status and controls | The observed process version selects the appropriate profile; exact process, pane, native thread, composer and current UI checks still apply. |
| Desktop | No new Desktop profile. Native writes retain the exact macOS **26.1002.52244 / build 13536** requirement and verified live owner. |

A thread's stored `cliVersion` is creation metadata. It cannot prove the
version of a currently attached frontend. Same-directory history cannot
merge a terminal with a shared-backend thread; the route requires exact native
identity. Busy/blocked state or an uncertain dispatch never triggers a retry
through another transport.

## Verification record

The dedicated live matrix is complete. The table distinguishes operations
actually executed from source/regression-only coverage and retained historical
evidence. The formal release gate also passed as recorded below.

| Evidence | Current scope |
| --- | --- |
| Earlier 0.14.1 targeted live proof | macOS CLI 0.162.1 + shared app-server 0.162.1: bounded public progress during an active task, 720-minute Send monitoring, one local completion acknowledgement and idempotent Send. |
| Dedicated frontend/backend pair | macOS CLI 0.162.1 + shared app-server 0.162.1, launched through the existing `mycodes --remote` wrapper in a dedicated test session. |
| Native status, exact identity and List | Passed: the closed native `/status` transaction proved the exact thread and enabled alias coalescing; subsequent materialized-thread backend Status read the same target. |
| Unmaterialized empty thread | Passed in a separate dedicated 0.162.1/0.162.1 CLI: List withheld Send/permission offers, Status/native inspection retained verified idle identity with unscanned requests and a null pending count, and an attempted semantic Send was rejected before a native turn, Watch or callback was created. The thread stayed empty and global configuration was unchanged. |
| Model discovery | Passed: the public model-options operation read seven native models and restored the composer. Model mutation was intentionally not exercised because the existing terminal setter persists defaults; its scope remains covered by source review and regressions. |
| Backend permissions | Passed: Default, Full Access and Read Only round trips retained the selected native thread. This is backend permission evidence, not a terminal menu round-trip claim. |
| Routed Send, Status, Watch and completion | Passed: Send through the terminal alias selected the native backend, proved acceptance and a 720-minute deadline; Status using the returned native conversation ID and Watch ID read the same active turn and bounded progress. The exact turn completed with one local callback acknowledgement; idempotent Send retained the original Watch and deadline. Reading the old Watch after later turns still returned its original task's progress without later-task text. |
| Backend command/file approvals | Passed: real requests in the selected test task were approved through their exact native interaction identities; the task completed with one local callback acknowledgement and idempotent repeat handling. |
| Backend blocking and asynchronous questions | Passed: both answers to a two-question blocking request were received, and an asynchronous free-text answer retained Chinese, emoji and a newline through the final result. Each completion acknowledged once; repeated handling did not duplicate the answer or callback. |
| Terminal question surface recognition | Real captured blocking-question UI was recognized as actionable under the v5 profile; the captured asynchronous `⇧←` queue hint was recognized as collapsed. Answers in this live matrix used the backend route. Terminal answer-key injection is covered by regressions, not a new live execution claim. |
| Recovery, Renew, Watch and Unwatch | Passed: after stopping only the isolated test monitor, Recover relaunched observation with its original deadline. No-argument backend Renew used about 720 minutes. A new explicit Watch bound the same active turn with 720 minutes; Unwatch stopped only that observation while the native task continued and the original Send Watch completed once. |
| Close and accepted callback retry | Passed: Close released AKK management while preserving the same idle native thread. Retrying an already accepted callback was rejected without another notification. |
| Terminal permission mutation | Passed through the production TerminalAgentBridge and real tmux capture/input: Read Only, Ask for approval, Approve for me and Full Access each changed successfully; the new centered Full Access dialog was confirmed and the final catalog restored the initial Full Access setting. Before every input, the harness rechecked process incarnation, pane, cwd, frontend version and the same idle backend thread. Global configuration remained unchanged. |
| Older frontend/backend combinations | Regression coverage retained; no new old-version live run is claimed without a separate recorded result. |
| Desktop live | Explicitly skipped. Relevant regressions remain part of the release gate. |
| Fast regressions | Final `npm run test:fast`: 2,836 passed, zero failures. |
| Static/build checks | Type checking, architecture validation and canonical/bundled Skill consistency passed. The Skill's reviewed-version lists include 0.162.1; independent connector package versions are unchanged. |
| Full regressions | Final release-gate full suite: 3,351 passed, zero failures, on Node.js 24.18.0. |
| Runtime provenance | All 1,050 compiled runtime files matched the immutable build used for the final live matrix by individual SHA-256 comparison. |
| Formal release gate | `npm run test:release` passed: full suite, isolated OpenClaw 2026.9.1 compatibility, ClawHub runtime validation and publication dry-run. |
| Isolated OpenClaw | Loaded all 25 tools; callback, doctor, bundled Skill, tmux fixture/diagnostics, update/reinstall and uninstall checks passed. The existing user Gateway was not restarted or upgraded. |
| ClawHub/package validation | Runtime Plugin Inspector passed with zero breakages and zero warnings. `npm pack --dry-run` and ClawHub publication dry-run passed with 1,094 files; the canonical bundled Skill and this compatibility report were included, while tests, node_modules, Git metadata and private proof artifacts were excluded. Registry/download verification remains a separate publication step. |

Callback acknowledgement at a local test receiver proves AKK callback
generation/delivery and deduplication at that receiver. It does not prove a
new OpenClaw-to-WeChat delivery. No user conversation, shared daemon or Gateway
needs to be restarted to run isolated compatibility checks.

The optional general native lifecycle live-smoke was not run: paginated
new/resume remains unsupported, and the dedicated matrix above covers the
actual routes changed in this release. Desktop live verification was skipped
by explicit choice; it is not reported as passing.

An old terminal alias without current native identity can still return terminal
activity while work is active; AKK does not type `/status` into that busy
terminal to force a merge. The Send-returned native conversation and Watch
identifiers retain the exact backend route. No identity guard was relaxed to
make the alias appear resolved.

For the stopped explicit Watch, its legacy task `status` can remain `watching`;
`observation_state: "stopped"` and `observation_active: false` describe the
monitoring state. Unwatch is not native cancellation or task completion.

## Retained limits

- Direct CLI model control and cancellation still require an eligible verified
  terminal capability. Native new/clear/resume remains unsupported for these
  paginated versions; adding a version profile does not enable lifecycle work.
- A newly loaded CLI thread with no materialized history is not automatically
  writable through the direct adapter: upstream `thread/resume` requires stored
  history. Reading its live metadata is different from acquiring a task/response
  channel. Such a thread must not be advertised as Send-ready solely because it
  is loaded and idle.
- The Status public body remains bounded to 800 Unicode code points, with
  redaction, grapheme-safe truncation and exact-turn freshness/error reporting.
  List gains no progress body or pagination changes in this release.
- The shared 720-minute monitoring hard deadline, managed-terminal 60-minute
  inactivity window, existing absolute deadlines and notification deduplication
  remain unchanged. Recover does not replay a task or silently renew it.
- macOS terminal glyph evidence does not establish Linux/Windows UI validation.
  Desktop live behavior and other Desktop builds are not newly certified.

## Sources

- [Official 0.162.1 release](https://github.com/openai/codex/releases/tag/rust-v0.162.1)
- [Official 0.160.0 to 0.162.1 source comparison](https://github.com/openai/codex/compare/rust-v0.160.0...rust-v0.162.1)
- [Official 0.162.1 native status card source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/status/card.rs)
- [Official 0.162.1 app-server API](https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/app-server-protocol)
- [Official loaded-thread read and resume implementation](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_processor.rs)
- [Earlier 0.160.0 compatibility evidence](codex-0.160.0-compatibility.md)

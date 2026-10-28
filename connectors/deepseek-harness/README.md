# Agent Knock Knock for DeepSeek Harness

This package is the native DeepSeek Harness Web connector for Agent Knock
Knock (AKK). When the Web Host mounts the bundle, it adds `/akk`, the AKK
semantic tools supplied by its pinned runtime, and the bundled
`agent-knock-knock` skill to every live Agent.
There is no `/akk-bind` step, separate skill installation, or session id for
the user to copy.

The connector is developed in the AKK repository but is an independent npm
package. It does not modify DeepSeek Harness and has its own version, build,
tests, lockfile, bundle manifest, and connector-specific release tag.

## Compatibility

Connector **0.1.0-rc.16** pins AKK **0.16.5** in its package and lockfile,
including scoped persistent callback recovery and verified running-process
Codex version discovery, with the 0.165.0 adaptation and accurate Claude
pane-observation diagnostics. It exposes that runtime's 27 semantic tools,
including Codex CLI backend and Desktop operations when the selected
conversation advertises them. `list`
returns current discoverable conversations; `watches` separately returns recent
monitoring records (24 hours by default), plus active or unresolved records.
A newer root checkout does not silently replace this pinned dependency. This
prerelease uses the `next` dist-tag.

The development baseline is DeepSeek Harness **0.2.1-rc.2** with Cordis
**4.0.5**. This is a release candidate, not a stable release; as checked on
2026-10-17, npm `next` points here while `latest` still points to
**0.2.0-rc.2**. Do not downgrade a newer installed RC just to follow `latest`.
Previously reviewed Hosts `0.1.1-rc.2`, `0.1.2-alpha.1`, `0.1.5-rc.2`,
`0.2.0-rc.2`, and preview `0.2.1-alpha.2` remain accepted. Use a resident POSIX Web Host
and Node.js `>=22.19.0`.

Activation locates the real `@deepseek-ai/dsh` launcher and requires the
launcher, `dsh-base`, `dsh-agent`, `dsh-commands`, `dsh-llm`, `dsh-skill`, and
`dsh-tools` to form one coherent reviewed version. Unsupported, missing, and
split runtime sets fail before mounting. The Host's own plugin peer preflight
must also pass without a version-risk exemption. Message and schema helpers
come from that verified Host tree, not checkout development dependencies.

Callbacks use AKK's producer-specific message source and the exact live Agent's
Inbox. Idle Agents receive a waking `followup`; running Agents receive
`inject` context at a later step. Acceptance does not prove that a model has
consumed the message or a user has seen it. Hosts with the required persistent
Session resolver, event inventory and flush barrier can restore the original
Session after restart within the same Web Profile and AKK Store. Earlier
process-private Watches require explicit operator adoption; a matching session
ID alone is never recovery authority. Older Hosts without these APIs retain
live-session delivery only. See [Callback delivery and recovery](#callback-delivery-and-recovery).

Headless/one-shot Harness processes, Windows named pipes, and DSH Desktop's
embedded launcher are outside this connector's validated scope. Existing Codex CLI backend and Desktop connections need no
terminal container when their advertised capability is available. Claude Code
and terminal-specific operations retain their documented transport conditions;
see [core compatibility](../../README.md#compatibility) and the
[Pi/DSH validation matrix](../../docs/pi-dsh-compatibility.md). This connector does
not launch replacement coding processes or create terminal panes.

## Five-minute quick start

### 1. Check the prerequisites

The Web Host must be one of the supported DeepSeek Harness releases, Node
must satisfy the engine above, and `pnpm` must be on `PATH` because `dsh plugin`
forwards package operations to pnpm.

```sh
node --version
dsh --version
pnpm --version
npm view @scotthuang/agent-knock-knock-deepseek-harness dist-tags --json
```

The last command reports registry state; this repository does not assume that a
particular prerelease is present in every configured npm registry. Connector
prereleases use the `next` tag when published. Installing without `@next`
can select an older `latest` build.

### 2. Add the connector to the Web profile

DSH `0.2.1-rc.2` requires connector `0.1.0-rc.6` or a later release that
explicitly supports that Host. Connector `0.1.0-rc.5` does not support this RC.
Use `next`, or pin
`@scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.16`.

```sh
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
```

Stop the current Web Host cleanly if it is running, then start a fresh process
so the new bundle is mounted:

```sh
dsh web
```

Do not start a second Web Host merely to reload the connector. The callback
route belongs to the Host process and exact Agent that accepted the command or
tool invocation.

### 3. Verify discovery in a Web conversation

Open a supported Codex CLI or Desktop conversation, or a supported coding
agent in tmux/Herdr for the terminal workflow, then enter:

```text
/akk list
```

The compact result contains the visible CLI/Desktop conversations, current action names, and only
the dynamic inputs needed for those actions. Static action meanings and safety
rules come from the automatically registered `agent-knock-knock` skill. AKK
never asks callers to invent identifiers: copy only the complete
`conversation_id`, `terminal_id`, `session_id`, `turn_id`, `watch_id`, or `native_thread_id`
returned by AKK.

### 4. Send one task and receive its callback

For the terminal shortcut, if exactly one matching terminal is send-ready,
this is a complete smoke test:

```text
/akk codex: Inspect package.json and report the package name. Do not modify files.
```

Use `claude:` instead when testing Claude Code. For backend/Desktop routes or multiple matches,
run `/akk list` and let the Agent call `agent_knock_knock_send` with the exact
identifier in the selected row's advertised action. AKK chooses the available
transport; do not reconstruct IDs from project paths.

A backend/Desktop Send normally returns its exact task Watch. Terminal managed
Send returns a `turn_id`; preserve the actual receipt instead of assuming one
record type. An existing automatic Watch does not need a second subscription.
When the coding agent finishes,
asks a question, becomes blocked, or requests approval, AKK sends a callback to
the same live DeepSeek Harness Agent. A running Agent receives the update via
`inject()`; an idle Agent receives it via `followup()`.

If stale or broken AKK management prevents managed delivery before terminal
input, an explicit user Send can instead be delivered once through the physical
terminal and best-effort attach a Terminal Watch. That result has no managed
callback Turn; retain its returned `watch_id` for callback recovery. A warning
that Watch attachment failed does not undo an already successful Send.

### 5. Observe work that AKK did not send

Terminal Watch is read-only and can follow an existing human-started task
without creating an AKK Session or Turn:

```text
/akk list
/akk watch <complete-terminal-id-from-list>
/akk status <watch-id-returned-by-watch>
/akk unwatch <watch-id-returned-by-watch>
```

Watch prefers an exact task anchor and otherwise degrades to warning-bearing
terminal activity observation. A fallback Watch can prove stable idle, not that
one uniquely identified task produced the final output.

## Tool workflow

The slash command is the human-facing shortcut. Agents receive the same
behavior through the complete capability-handshake-verified tool catalog:

| Tool | Purpose |
| --- | --- |
| `agent_knock_knock_list` | List current CLI/Desktop conversations and each row's currently available actions, without Watch history. |
| `agent_knock_knock_watches` | Read bounded recent monitoring records (24 hours by default) plus active/unresolved records; follow returned pagination. |
| `agent_knock_knock_watch` | Observe one advertised conversation or terminal, preserving its exact task anchor when available. |
| `agent_knock_knock_unwatch` | Stop one exact `watch_id` without sending terminal input. |
| `agent_knock_knock_list_resumable_threads` | List structurally verified native threads for one terminal. |
| `agent_knock_knock_native_inspect` | Run only the adapter-owned native `status` inspection advertised for an idle terminal. |
| `agent_knock_knock_model_options` | Read one exact idle terminal's native model and reasoning catalog and create a single-use typed offer. |
| `agent_knock_knock_repair_model_control` | Dismiss only an exactly recognized stale model-control surface; it never selects a model or submits work. |
| `agent_knock_knock_permission_options` | Read currently available permission choices for one exact target. |
| `agent_knock_knock_set_permissions` | Apply one currently advertised permission choice. |
| `agent_knock_knock_desktop_create` | Create a Codex Desktop conversation only when the creation capability is advertised. |
| `agent_knock_knock_recover` | Perform an advertised recovery action on its original observation or callback record. |
| `agent_knock_knock_set_model` | Consume the current catalog offer to choose one advertised semantic model and reasoning effort. |
| `agent_knock_knock_identify_foreground` | Run a bounded diagnostic native identity probe without creating durable authority. |
| `agent_knock_knock_identify_and_send` | Keep one terminal lock across identity observation and one explicit Send when foreground identity is ambiguous. |
| `agent_knock_knock_new_thread` | Start and verify a clean native coding-agent thread after explicit user intent. |
| `agent_knock_knock_reconcile_binding` | Detach one proven stale conflicting binding after explicit confirmation; it neither sends work nor adopts a thread. |
| `agent_knock_knock_resume_thread` | Resume one complete `native_thread_id` from a fresh resumable-thread listing. |
| `agent_knock_knock_status` | Read one conversation, Turn, or Watch; backend progress is bounded and belongs to the exact native task. |
| `agent_knock_knock_send` | Send a new task through the exact action advertised by `list`. |
| `agent_knock_knock_respond` | Answer a question or unblock one existing managed Turn; it does not create a new Turn. |
| `agent_knock_knock_respond_interaction` | Answer the current typed native questionnaire step for one exact response-capable Turn or Watch. |
| `agent_knock_knock_approve` | Apply the advertised allow-once or reject decision to the current exact permission request, after human review. |
| `agent_knock_knock_renew` | Renew monitoring for a still-live stalled Turn without typing into the terminal. |
| `agent_knock_knock_retry_callback` | Retry one persisted failed callback with its original message and delivery identity. |
| `agent_knock_knock_cancel` | Interrupt one exact active Turn while leaving the shared pane open. |
| `agent_knock_knock_close` | Release AKK management of a Turn without terminal input, process interruption, or pane closure. |

The ordinary closed loop is:

1. Call `list` and select one exact conversation or terminal row.
2. Use only that row's advertised `send` action and semantic identifier.
3. Retain the returned `turn_id` or automatic `watch_id`. Completion or attention callbacks return
   to the originating DeepSeek Harness Agent.
4. For a managed question or blocked callback, use `respond` with its `turn_id`.
   For a permission request, follow the approval procedure below.
5. Use `status` when a callback is late or uncertain. Add an explicit `watch`
   only when the user requests monitoring of ongoing work that has no suitable
   active monitor. A Send-created Watch already owns its completion subscription.

Do not cache `available_actions` or private terminal state. Refresh `list` or
`status` before a mutation, and never blindly retry an uncertain Send,
approval, cancel, native inspection, or native thread transition.

## Active approval

The DeepSeek Harness connector registers AKK's approval tool directly; unlike
the Pi connector, this prerelease does **not** add a Host-native confirm/select
dialog around that tool. Explicit human confirmation is therefore a required
calling contract for the Agent and user, not a UI gate enforced by this
connector. With the default configuration, the manual flow is:

1. Receive the approval callback, then refresh Status using its exact
   `watch_id`, `conversation_id`, or managed `turn_id`. Read the current native
   request; terminal routes may also return a screen excerpt.
2. Present the current request, tool name, and relevant arguments to the user.
3. Obtain an explicit allow-once or reject decision in the same Web conversation.
4. Copy the currently advertised `agent_knock_knock_approve` action, keeping its
   exact target and `interaction_id` where supplied. Pass `decision: "approve_once"`
   or `decision: "reject"` only when that target advertises the corresponding
   decision. The legacy `/akk approve <turn-selector>` shortcut is for managed
   Turn approval, not a replacement for direct interaction identifiers.
5. If the operation was interrupted or returned an uncertain result, refresh
   Status and inspect the original conversation. Never retry it blindly.

AKK's deterministic `pluginConfig.autoApprove` policy remains disabled by
default. If an administrator deliberately enables it, only the exact configured
agent, workspace, and command-vector rules may bypass this manual flow; unmatched
or ambiguous requests still require the confirmation procedure above.

A separately advertised terminal-scoped approval has no managed `turn_id`.
Refresh `list`, show that row's current approval request to the user, and after
explicit confirmation call the advertised `approve` action with its complete
`terminal_id`. Never convert a terminal-scoped approval into a guessed Turn.

The related controls are deliberately different:

- `respond` supplies text to a question or blocked managed Turn. It is not an
  approval and is not a generic denial button.
- `cancel` interrupts the exact active task after explicit user intent. It does
  not close the pane. A user's rejection must not be silently converted into
  Cancel; ask separately whether they want the task interrupted or prefer to
  handle the permission prompt in the live TUI.
- `close` only releases AKK's management records. It sends no terminal input and
  does not stop the coding agent; refresh `list` and use `watch` if the process
  continues working.
- `unwatch` stops observation only. It never interrupts the watched task.

## Callback delivery and recovery

On Hosts exposing persistent session recovery and a durability barrier, callback
ownership is stored under the canonical Web Profile and AKK Store. Restarting
that same Host restores the original persistent Session through DSH's session
controller. The callback contract revision stays stable across restarts; the
private socket and token still rotate. Each callback uses the current runtime's
helper and credentials, never an old socket left in a temporary directory.

- A successful callback acknowledgement means DSH admitted the message and its
  session durability barrier completed. It does not prove that the model has
  consumed the message or that the browser displayed it.
- Delivery identity and the precreated DSH message ID are journaled before
  admission. Retries retain the original ID; after restart, recovery checks the
  original Session's own persisted events, including consumed inbox messages.
  Inherited fork messages do not prove admission. Ambiguous evidence remains
  uncertain instead of authorizing a duplicate injection.
- The same session ID alone is not recovery authority: profile/Store ownership,
  immutable Session header, and the live Agent object must match. A different
  same-ID Agent in the current process cannot inherit an existing callback.
- Inspect the original `turn_id` or `watch_id` with `status`. Observation and
  settlement are separate from notification delivery. A working or unknown
  activity Watch does not settle merely because the Host restarted. Terminal
  activity becoming idle remains best-effort evidence, not exact task success.
- Older Hosts without the required APIs retain live-session callback behavior
  and log that restart recovery is unavailable. OpenClaw and other connectors
  do not opt into the DSH recovery authority.

Watches created by the earlier process-private connector require explicit
operator adoption; their nonce and encoded Session ID do not establish which
Web Profile owns them. Select the original Watch and its original generated
Profile file in the configuration below. AKK validates both records, the known
connector callback contract, and the original persistent DSH Session before
recording scoped adoption. It does not rewrite the Watch, change its deadline,
reset an uncertain/permanent notification, or run the historical helper. Once
adoption is recorded, the old temporary file is no longer required. Missing or
conflicting evidence stops adoption with a diagnostic; do not hand-edit Store
records or substitute a similarly named Session.

## Configuration

The connector accepts an optional lifecycle cadence and the existing AKK plugin
configuration object:

```yaml
- id: agent-knock-knock-deepseek-harness
  name: '@scotthuang/agent-knock-knock-deepseek-harness'
  config:
    lifecycleIntervalMs: 5000
    # Optional, explicit one-time adoption of an earlier connector's Watch:
    # callbackRecovery:
    #   adoptWatches:
    #     - watchId: terminal-watch-user-send-<exact-id>
    #       historicalProfilePath: /absolute/path/to/original/host-profile.json
    pluginConfig:
      storeDir: /absolute/path/to/akk-store
```

`lifecycleIntervalMs` must be at least 50 milliseconds. Use an absolute
`storeDir`; a relative value is resolved from the Web Host's working directory.
When omitted, this connector uses
`~/.agent-knock-knock/hosts/deepseek-harness/store` for both tools and lifecycle
reconciliation. Keep a custom Store separate from OpenClaw, Pi, and other DSH Host processes.
The opt-in recovery runtime filters unowned callback routes before claiming
notifications; this does not authorize unrelated Hosts to share Store writers.

The default separates DSH from other Host types, not from another DSH process.
If running multiple DSH Hosts or profiles concurrently, configure a distinct
`pluginConfig.storeDir` for each.

This update does not move or replay records from the older shared
`~/.agent-knock-knock/store`. Existing records remain there unchanged. An
explicit `pluginConfig.storeDir` is preserved; sharing that directory still
has the limitation above.

The optional bundle patch mounts only the Host plugin:

```yaml
- insert:
    - id: agent-knock-knock-deepseek-harness
      name: '@scotthuang/agent-knock-knock-deepseek-harness'
```

## Security and storage

- Each Host process creates a private temporary directory with mode `0700`.
  Its generated Host Profile is mode `0600`; the directory is removed during a
  clean connector shutdown.
- The callback socket path and random token travel only through an allowlisted
  environment. They are not command arguments. The callback helper uses the
  absolute Node executable and package artifact without a shell or `PATH`
  lookup.
- The callback IPC frame is authenticated and bounded. Successful admission is
  tied to the authorized persistent Session and its current exact Agent object.
- Durable callback authority and delivery journals are private files under
  `<profile>/.akk-callback-authority/`, scoped to the canonical Store path. An
  exclusive process-generation lock rejects concurrent owners; only a proven
  dead owner can be reclaimed. Keep this directory when upgrading or backing
  up the profile. Deleting it discards restart recovery authority.
- AKK's durable Store contains task, Session, Turn, receipt, watch, and callback
  recovery metadata and may contain user request or callback text. AKK creates
  Store directories as `0700` and files as `0600`; keep a custom Store on a
  trusted local filesystem owned by the Host user. Do not share one writable
  Store between unrelated users.
- Uninstalling the connector does not delete the durable AKK Store. Retain it if
  recovery or audit history is still needed; archive or remove it only after
  confirming there are no active Turns or Watches that depend on it.

## Troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| `dsh plugin` cannot run | Confirm `pnpm --version` succeeds. The DeepSeek Harness plugin command forwards its arguments to pnpm. |
| `@next` cannot be resolved | Run `npm view @scotthuang/agent-knock-knock-deepseek-harness dist-tags --json`. Use an exact published version if your registry has no `next` tag, or use the local-development installation below. |
| `/akk` and AKK tools are missing | Verify installation with `dsh plugin --profile web why @scotthuang/agent-knock-knock-deepseek-harness`, then fully restart the Web Host. Existing Host processes do not gain a newly added bundle. |
| Activation reports an unsupported or split Harness | Check `dsh --version` and run `dsh plugin --profile web why @deepseek-ai/dsh-base @deepseek-ai/dsh-agent @deepseek-ai/dsh-commands @deepseek-ai/dsh-llm @deepseek-ai/dsh-tools`. Update the whole Host coherently; do not repair it with a standalone connector npm install. |
| `/akk list` finds no live conversations | Check the selected target's direct-connection or terminal discovery diagnostics and core compatibility. A supported Codex CLI backend/Desktop connection does not require tmux/Herdr; terminal-only control needs an eligible live pane. Do not infer missing identity from cwd alone. |
| A mutation is absent or rejected | Refresh `/akk list` or structured `list` and use only the action currently advertised for that exact row. Resolve a current approval first when it blocks input. Do not reuse stale IDs or action payloads. |
| The callback never appears | Query the original Turn/Watch Status and separate task result, callback admission, and user visibility. Use only a retry/recovery action advertised for that record and requested by the user. Recovery requires the same profile/Store owner and original persistent Session; legacy routes require explicit adoption. |
| Callback delivery reports IPC unavailable or timeout | Inspect the current Host startup and recovery diagnostics. A restarted authorized Host uses its new private socket; old socket files are not recovery targets. Missing session authority must be resolved explicitly. |
| A Watch completed but its callback was missed | Read the original `watch_id` Status for its exact task result and callback disposition. Do not create a replacement Watch for completed work or treat it as historical-notification recovery. |
| A tool call fails schema validation | Pass only the documented fields and complete semantic IDs returned by AKK. DeepSeek's discovery schema is a projection; the connector always enforces the full original AKK schema before execution. |
| Windows, headless, or one-shot use fails | These surfaces are outside this prerelease's supported scope. Use the resident POSIX Web Host. |

## Upgrade and uninstall

Inspect available versions before changing the profile:

```sh
npm view @scotthuang/agent-knock-knock-deepseek-harness versions --json
npm view @scotthuang/agent-knock-knock-deepseek-harness dist-tags --json
```

Update to the registry's current prerelease, or pin this
exact reviewed version:

```sh
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.16
```

Restart the Web Host after either operation. The connector pins the exact AKK
runtime version it was tested against, so updating the connector updates that
tested unit instead of letting the Host Adapter API drift independently.

To uninstall:

```sh
dsh plugin --profile web remove @scotthuang/agent-knock-knock-deepseek-harness
```

Restart the Web Host once more. Removal withdraws `/akk`, the tools, and live
callback routes; it does not delete the durable AKK Store.

## Local development

From the AKK repository root, install and build the child package, then add that
connector checkout to the Web profile:

```sh
npm --prefix connectors/deepseek-harness ci
npm run deepseek:build
dsh plugin --profile web add "file:$(pwd -P)/connectors/deepseek-harness"
```

Restart `dsh web` after installation. The child package currently installs and
tests against its pinned AKK runtime `0.16.5`; building the current repository
root does not silently replace that dependency. Before core publication, test
the candidate core tarball in isolation as described in the
[coordinated release policy](../../CONTRIBUTING.md#coordinated-package-releases);
the registry-based `npm ci` above requires that exact core to be published.
Testing connector changes against another AKK runtime requires an explicit
dependency change and
compatibility review rather than an implicit local link.

## Tests and release status

Connector **`0.1.0-rc.16`** pins AKK **`0.16.5`** and its synchronized Skill.
It carries [PR #475](https://github.com/scotthuang/agent-knock-knock/pull/475):
Claude List now distinguishes an explicitly skipped pane scan
(`screen_not_scanned`) from unavailable capture evidence (`screen_unavailable`),
instead of incorrectly reporting an unrecognized Composer. The result explains
how to refresh the observation; missing evidence still cannot authorize Send.
Actual Composer, draft, stash, foreground-work and exact-target checks remain
unchanged, as do Host version ranges and callback/restart ownership. This
coordinated dependency refresh adds no new DSH live-model or external-channel
delivery claim and remains on npm `next`.

Connector **`0.1.0-rc.15`** pins AKK **`0.16.4`** and its synchronized Skill.
It carries the [Codex CLI 0.165.0 compatibility update](../../docs/codex-0.165.0-compatibility.md):
exact frontend/backend version reporting, native terminal profiles, Terra model
label handling, and manual folder-trust blocking. Existing task identities,
monitor deadlines and callback receipts are preserved. Host version ranges and
callback/restart ownership are unchanged. This coordinated dependency refresh
adds no new DSH live-model or external-channel delivery claim and remains on npm `next`.

Connector **`0.1.0-rc.14`** pins AKK **`0.16.3`** and its synchronized Skill.
Hosts with the required persistent Session resolver, event inventory and flush
barrier can recover callback ownership within the same Web Profile and AKK
Store. Durable message IDs, admission journals and exact Session/Agent checks
preserve deduplication across restarts; restored callback aliases do not change
the tools' current action authority. Earlier process-private Watches require
explicit operator adoption, and older Hosts without these APIs remain live-only.
A callback acknowledgement proves durable Host admission, not model consumption
or delivery to an external channel. Codex version discovery also verifies the
selected process's mapped executable instead of borrowing an installed version.
The supported DSH/Cordis version set is unchanged. This release does not extend
restart recovery to Pi/OpenClaw or claim acceptance for every Host/native task;
see [Callback delivery and recovery](#callback-delivery-and-recovery) for the
scope and evidence requirements. The connector remains on npm `next`.

Connector **`0.1.0-rc.13`** pins AKK **`0.16.2`** and its synchronized Skill.
Degraded terminal-activity Watches tolerate absent optional process UUID/birth
metadata. A proven identity change still invalidates the observation; temporarily
unavailable evidence remains unknown and retryable. A missing process working
directory may use the absolute path from the same selected terminal, never a
same-project candidate. These changes preserve exact-task, Store, input and
callback ownership boundaries. They do not fix exact-Watch recovery after a Host
restart, callback outbox recovery, or persistence when no workspace is known.
DSH Host compatibility is unchanged. This dependency refresh adds no new live
model or external-channel acceptance claim and remains on npm `next`.

Connector **`0.1.0-rc.12`** pins AKK **`0.16.1`** and its synchronized Skill.
List adds bounded guidance derived from each conversation's current state and
a single read-only recheck for unresolved Claude identity. Claude physical
fallback requires an empty recognized Composer, no visible stash and no active
or unproven foreground turn. A single empty-Composer restore probe stops if it
reveals content; no sentinel or draft-deletion transaction runs. Shared
notification/footer stash layouts are covered by fixtures, not a new live DSH
acceptance claim. Managed Send, Codex routing, Store writer protocol **11** and
List projection **v4** remain unchanged; action contract advances to **35**.
The DSH Host/peer policy, independent Store and callback ownership remain
unchanged. This dependency refresh does not repeat the historical live-model
or external-channel delivery acceptance below. It remains on npm `next`.

Connector **`0.1.0-rc.11`** pins exact AKK **`0.16.0`** and bundles
its synchronized Skill. Core separates managed binding reconciliation from
native Store authority transfer, records Store owner process identities, and
uses a durable transfer journal with evidence-based automatic recovery. Store
writer protocol advances to **11** (format **1**), action contract to **33**,
and List projection to **v4**. The relay's generic 90-second deadline no longer
kills `send`, `delegate`, or `respond` while they are proving text submission;
phase deadlines, explicit timeouts, and Host cancellation remain effective.

Live acceptance on DSH `0.2.1-rc.2` with Claude Code `2.1.295` covered both
managed-terminal and native-backend Send, exact Watch completion callbacks,
and native Store authority transfer without terminal input. Two consecutive
managed Sends in `permissionMode=default` (`manual mode`) proved text injection,
Enter dispatch, and agent acceptance; the second also completed callback
delivery. Permission mode is not an input-delivery gate. This does not claim
native Claude approval/question responses, permission-mode switching, or new
Host-version compatibility. The connector retains the existing DSH
Host/peer policy and is distributed through `next`.

Connector **`0.1.0-rc.10`** pins AKK **`0.15.0`** and bundles its updated
Skill. Claude Code and configured wrappers such as `tclaude` share the same
adapter. New Claude Sends prefer an exact eligible terminal with managed
completion monitoring and supported approval controls; native inbox fallback
remains available when no controllable terminal counterpart exists. Codex stays
backend-first. Existing task routes, interaction authority, the DSH Host/peer
policy, independent Store and callback ownership remain unchanged. This
dependency update does not claim a new DSH live-model or external-channel
delivery test. See the [Claude direct-control guide](../../docs/claude-cli-direct.md)
for prerequisites and operation-specific limits. The connector remains on `next`.

Connector **`0.1.0-rc.9`** pins AKK **`0.14.17`** and carries its Codex CLI
`0.164.0` compatibility changes and reviewed Skill. The DSH Host/peer version
policy, independent Store, typed interactions and callback ownership are
unchanged. The core [compatibility matrix](../../docs/codex-0.164.0-compatibility.md)
separates native backend task/approval/question checks from terminal capture
regressions and retained limits. This dependency refresh does not claim a new
DSH live-model or external-channel delivery run. It remains on npm `next`.

Connector **`0.1.0-rc.8`** updates the pinned core from `0.14.15` to `0.14.16`
and bundles the corresponding Skill. Default List folds unnamed, unstarted
Codex candidates beside an established conversation; diagnostic List retains
their exact IDs. This is display folding, not proof that a candidate has no
frontend, and it does not change Send routing or callback ownership. Sole
empty conversations and exact frontend associations remain visible. The
complete 27-tool catalog, generated Skill handshake, and separate List/Watches
routes are retained, as is the DSH Host compatibility policy
introduced in `0.1.0-rc.6`; it does not add a new Host version. Prerelease
publication uses `next` and does not promote `latest`. Registry state can
change independently of this source file, so the `npm view` commands above
remain authoritative.

From `connectors/deepseek-harness`, the normal development gate is:

```sh
npm ci
npm run typecheck
npm run test:fast
npm run pack:check
```

These commands typecheck the connector, run its fast wiring/profile/IPC/schema
tests, and inspect the package tarball. They do not publish anything. The
`0.1.0-rc.16` lockfile uses the published DeepSeek Harness `0.2.1-rc.2`
SDK packages and Cordis `4.0.5`. Its real ToolRuntime regression checks
canonical result rendering, exact Agent ownership, typed questionnaire payloads,
and rejection before dispatch when targets are ambiguous or stale. This is
an isolated registry test, not a live-model acceptance claim. The `rc.7`
regression also uses the real DSH ToolRuntime and pinned HostAdapter to verify
List/Watches separation, filter forwarding, pagination preservation, and
pre-dispatch rejection of invalid history/window requests. The CLI executor
is a fixture, so this does not contact live coding sessions or deliver callbacks.
The earlier `0.1.0-rc.6` sources also passed typecheck, 39 fast tests and coherent launcher/helper
resolution with `0.2.0-rc.2`, retained `0.1.5-rc.2`, and preview
`0.2.1-alpha.2`. Old-version Web/model acceptance was not repeated. The older `0.1.1-rc.2` and
`0.1.2-alpha.1` compatibility policy is retained; it is not a new full Web
acceptance claim for those releases. Deterministic Host-loop checks use the
real upstream registries and Inbox with a scripted model provider; they are
not evidence of a live paid model or external-channel delivery.

## Release safety

`npm run release:check` is check-only. The shared connector gate first proves
the generated Skill hash, package manifest/constants/lock/dependency parity,
then runs typecheck, fast tests, and inspection of the real package tarball. In
release mode it additionally rejects a dirty tree, a non-`main` branch, an
unsynchronized upstream, an existing npm version or connector repository tag,
and any runtime `file:`, `link:`, or `workspace:` dependency.

Activation separately verifies the pinned AKK HostAdapter's versioned,
secretless capability handshake. The authoritative catalog digest, ordered
tool names and derived count, and Skill digest must match the generated Skill
and the tools registered with DeepSeek Harness. A missing/unknown handshake,
forged digest, or partial registration fails closed; the connector has no
independent hard-coded tool count.

For deterministic local verification without a registry or git-remote query:

```sh
npm run release:check -- --offline
```

From the repository root, `npm run connectors:verify` applies that same offline
gate to both connectors. Their package versions are validated independently.

Publishing additionally requires both explicit flags:

```sh
npm run release:check -- --publish --confirm-version 0.1.0-rc.16
```

Prereleases use npm tag `next`; stable versions use `latest`. Repository tags
and GitHub Releases use the connector-specific namespace
`deepseek-harness-v<version>` and are created separately after npm verification.

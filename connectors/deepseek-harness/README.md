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

This connector pins AKK **0.14.7** in its package and lockfile. It exposes
that runtime's 26 semantic tools, including Codex CLI backend and Desktop
operations when the selected conversation advertises them. A newer root
checkout does not silently replace this published dependency.

The development baseline is DeepSeek Harness **0.2.0-rc.2** (the upstream
`latest` channel). **0.2.1-alpha.2** is separately reviewed preview support.
Neither is a stable release. The older reviewed Hosts `0.1.1-rc.2`,
`0.1.2-alpha.1`, and `0.1.5-rc.2` remain accepted. Use a resident POSIX Web Host
and Node.js `>=22.19.0`.

Activation locates the real `@deepseek-ai/dsh` launcher and requires the
launcher, `dsh-base`, `dsh-agent`, `dsh-commands`, `dsh-llm`, `dsh-skill`, and
`dsh-tools` to form one coherent reviewed version. Unsupported, missing, and
split runtime sets fail before mounting. The Host's own plugin peer preflight
must also pass without a version-risk exemption. Message and schema helpers
come from that verified Host tree, not checkout development dependencies.

Callbacks use AKK's producer-specific message source and the same live Agent's
Inbox. Idle Agents receive a waking `followup`; running Agents receive
`inject` context at a later step. Acceptance means Inbox admission, not proof
that a model has consumed it or a user has seen it. Host exit or plugin unload
invalidates that Host instance's routes; callbacks do not migrate to a new
Agent merely because it has the same session ID.

Headless/one-shot Harness processes, Host-exit callback continuity, Windows
named pipes, and DSH Desktop's embedded launcher are outside this connector's
validated scope. Existing Codex CLI backend and Desktop connections need no
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
prereleases use the `next` tag when published.

### 2. Add the connector to the Web profile

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
| `agent_knock_knock_list` | List CLI/Desktop conversations, monitoring records, and each row's currently available actions. |
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

The synchronous callback acknowledgement means that the message was admitted
to the exact DeepSeek Harness Agent's inbox/session log. It does not prove that
the model consumed the message or that asynchronous persistence reached stable
storage. `status` and Terminal Watch are the recovery path.

- Inspect the original `turn_id` or `watch_id` with `status`. If that exact
  record advertises `retry_callback`, a requested retry reuses the persisted
  callback message and delivery identity. An uncertain result is not evidence
  of non-delivery; do not replay it without a supported recovery action.
- A completed Watch still provides its exact result even when the original
  callback route is gone. Read that result; creating another Watch does not
  recover or replay the historical notification. For work that is still
  running, a fresh observation from a current `list` row requires the user's
  monitoring request. Do not transfer an old record's callback ownership.
- A Host restart creates a new private Profile revision. Existing watches retain
  their original route, so callbacks owned by the old Host incarnation fail
  closed instead of being redirected to a new Agent. There is deliberately no
  cross-restart callback migration in this prerelease.
- Replacing an Agent object with another Agent that has the same session id also
  does not transfer its route. Start a current command/tool invocation from the
  new Agent before expecting new callback ownership.
- Exact process-lifetime idempotency records return the original acceptance id
  for a duplicate callback. Reusing an idempotency key with different content
  is rejected.

## Configuration

The connector accepts an optional lifecycle cadence and the existing AKK plugin
configuration object:

```yaml
- id: agent-knock-knock-deepseek-harness
  name: '@scotthuang/agent-knock-knock-deepseek-harness'
  config:
    lifecycleIntervalMs: 5000
    pluginConfig:
      storeDir: /absolute/path/to/akk-store
```

`lifecycleIntervalMs` must be at least 50 milliseconds. Use an absolute
`storeDir`; a relative value is resolved from the Web Host's working directory.
When omitted, AKK uses `~/.agent-knock-knock/store`.

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
  tied to one exact Agent object and one Host incarnation.
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
| The callback never appears | Query the original Turn/Watch Status and separate task result, callback admission, and user visibility. Use only a retry/recovery action advertised for that record and requested by the user. A new Host does not inherit old callback ownership. |
| Callback delivery reports IPC unavailable or timeout | Keep the originating Web Host alive and inspect whether it was restarted or disposed. The socket is Host-process-private and has an eight-second callback boundary; there is no cross-process fallback route. |
| A Watch completed but its callback was missed | Read the original `watch_id` Status for its exact task result and callback disposition. Do not create a replacement Watch for completed work or treat it as historical-notification recovery. |
| A tool call fails schema validation | Pass only the documented fields and complete semantic IDs returned by AKK. DeepSeek's discovery schema is a projection; the connector always enforces the full original AKK schema before execution. |
| Windows, headless, or one-shot use fails | These surfaces are outside this prerelease's supported scope. Use the resident POSIX Web Host. |

## Upgrade and uninstall

Inspect available versions before changing the profile:

```sh
npm view @scotthuang/agent-knock-knock-deepseek-harness versions --json
npm view @scotthuang/agent-knock-knock-deepseek-harness dist-tags --json
```

Update to the registry's current prerelease, or pin an exact reviewed version:

```sh
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.5
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
tests against its pinned published AKK runtime `0.14.7`; building the current
repository root does not silently replace that dependency. Testing connector
changes against another AKK runtime requires an explicit dependency change and
compatibility review rather than an implicit local link.

## Tests and release status

The package manifest is currently `0.1.0-rc.5`, so this remains a prerelease and
is published under `next`; `latest` remains on the earlier `0.1.0-rc.1` tag.
Registry state can change independently of this source file, so the `npm view`
commands above remain authoritative.

From `connectors/deepseek-harness`, the normal development gate is:

```sh
npm ci
npm run typecheck
npm run test:fast
npm run pack:check
```

These commands typecheck the connector, run its fast wiring/profile/IPC/schema
tests, and inspect the package tarball. They do not publish anything. The
`0.1.0-rc.5` lockfile uses the published DeepSeek Harness `0.2.0-rc.2`
SDK packages. The same source is checked separately against preview
`0.2.1-alpha.2` and retained `0.1.5-rc.2`. The older `0.1.1-rc.2` and
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
npm run release:check -- --publish --confirm-version 0.1.0-rc.5
```

Prereleases use npm tag `next`; stable versions use `latest`. Repository tags
and GitHub Releases use the connector-specific namespace
`deepseek-harness-v<version>` and are created separately after npm verification.

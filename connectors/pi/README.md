# Agent Knock Knock for Pi — POC

This Pi Extension makes Pi an Agent Knock Knock (AKK) orchestration Host. Pi
can use `/akk` and AKK's capability-handshake-verified semantic tools to control Codex and Claude Code
sessions that are already running, including supported Codex Desktop conversations.
AKK selects the available connection; supported direct connections do not need tmux or Herdr.

The connector does not modify Pi, launch or authenticate a coding agent, or
depend on an OpenClaw Gateway. It uses AKK's public HostAdapter and returns
callbacks to the exact initiating Pi session through a private local Unix
socket.

## Status and compatibility

This checkout's unpublished local preview **0.1.0-poc.9.list-guidance.6** pins
AKK **0.16.1-list-guidance.6**, including CLI direct connections, Codex
Desktop, Recovery, state-derived List guidance and a bounded Claude identity
recheck. The preview is built and installed from local tarballs, not from npm.
Its generated Skill and registered tools are verified
against that exact core package at startup. See the [root compatibility
summary](../../README.md#compatibility) for the coding-agent versions and
operation-specific limits. Updating AKK core elsewhere does not update this
connector's pinned dependency. The published connector `0.1.0-poc.8` pins core
`0.16.0` and uses the `next` dist-tag. The npm installation instructions below
refer to published packages, not this local preview.

This is a POC prerelease distributed on npm as
`@scotthuang/agent-knock-knock-pi`. Prereleases use the `next` dist-tag;
installing without `@next` can select an older `latest` build:

```sh
pi install npm:@scotthuang/agent-knock-knock-pi@next
```

The current compatibility contract is intentionally exact:

- Pi **`1.2.0`** (recommended), with **`0.84.4`** retained as an explicitly
  supported older runtime, installed from the official
  `@earendil-works/pi-coding-agent` package.
- Node.js `22.19.0` or newer.
- AKK `0.16.1-list-guidance.6`, pinned by this checkout's package and lockfile;
  the published connector pins `0.16.0`. A different version at the repository
  root is not substituted automatically. The unpublished preview requires its
  local core tarball; do not expect a registry-only install to resolve it. Before
  core publication, test its candidate tarball in isolation under the
  [coordinated release policy](../../CONTRIBUTING.md#coordinated-package-releases).
- macOS or Linux. The POC requires a POSIX Unix socket and does not support
  Windows named pipes.
- At least one authenticated, supported Codex CLI, Claude Code CLI, or Codex
  Desktop session under the same OS user. Terminal-only operations still require
  a verified tmux or Herdr target; capability fields describe each exact target.
- A configured Pi model/provider. Pi model authentication is separate from
  AKK and is not performed by this connector.

The connector accepts exactly `1.2.0` and `0.84.4`, and rejects other Pi
runtimes before it creates a socket or starts AKK lifecycle work. Pi's own packages remain `*` peer
dependencies as required by Pi's package contract; the runtime check is the
compatibility authority.

## Five-minute quick start

### 1. Install the accepted Pi version

```sh
npm install -g @earendil-works/pi-coding-agent@1.2.0
node --version
pi --version
```

Configure a model using Pi's normal `/login`, provider environment variable,
or settings flow before continuing.

### 2. Open a coding-agent session

Open a supported Codex CLI, Claude Code CLI, or Codex Desktop session in your
project. A supported direct connection needs no terminal container. For
terminal fallback or a terminal-only operation, you can instead start:

```sh
tmux new-session -s akk-pi-work -c "$(pwd -P)" codex
```

Wait for Codex to reach its interactive prompt, then detach with `Ctrl-b`
followed by `d`. Use `claude` instead of `codex` to test Claude Code. An
existing supported Herdr terminal works too.

### 3. Install the connector

```sh
pi install npm:@scotthuang/agent-knock-knock-pi@next
pi list
```

Using `next` follows compatible Pi connector prereleases. To pin the published
`0.16.0` core connector, install
`npm:@scotthuang/agent-knock-knock-pi@0.1.0-poc.8`; exact versions are pinned
and are not advanced by Pi's bulk update command.

### 4. Start Pi

```sh
pi
```

Pi should show `AKK ready`. The package manifest registers both the Extension
and its bundled `agent-knock-knock` skill, so no separate skill copy, `-e`
path, or repository checkout is required. The structured List result stays
small by returning current action names and dynamic inputs; Pi loads the skill
when it needs the static action meanings and safety rules.

### 5. Complete the first round trip

In Pi, list the live targets:

```text
/akk list
```

For direct CLI or Desktop targets, ask Pi to use the fresh List row's
advertised **`agent_knock_knock_send`** action and its exact `conversation_id`.
For example: "Use AKK to send a small read-only task to the Codex conversation
I selected, and wait for its existing completion callback."

The `/akk <task>` shorthand below is a **terminal-managed shortcut**, not a
direct CLI/Desktop Send. If exactly one terminal is send-ready:

```text
/akk reply with exactly AKK_PI_OK after inspecting the current workspace
```

For multiple terminal targets, use the fresh terminal selector printed by
`/akk list`:

```text
/akk @a1b2c3d4: reply with exactly AKK_PI_OK after inspecting the current workspace
```

Send returns its managed `turn_id` or direct-connection `watch_id`; when the
coding agent settles, its callback is injected into the same Pi session.
Inspect the exact selector from the Send receipt:

```text
/akk status <turn-selector-or-watch-id>
```

List returns conversations only. Query monitoring records separately with
`/akk watches` or `agent_knock_knock_watches`; do not add another Watch just to
find the observer already returned by Send. Fully settled, resolved records
can be pruned after 48 hours; unresolved records and deduplication receipts are
retained by AKK.

To observe work that you started manually in the terminal, copy the complete
`terminal_id` from a fresh list and start a read-only Watch:

```text
/akk watch <exact-terminal-id>
/akk status <watch-id>
/akk unwatch <watch-id>
```

Watch does not send, adopt, approve, interrupt, or reserve the task. Do not add
a second Watch merely to make a normal managed Send callback: managed Send
already has a callback. When a user-priority Send must fall back to unmanaged
physical delivery, AKK instead tries to attach the request-bound Watch itself
and returns its `watch_id`.

## Tool workflow

The usual product loop is:

1. **List** to discover live CLI/Desktop sessions and their current `available_actions`.
2. **Send** using the fresh action's prefilled `conversation_id`, `session_id`, or `terminal_id`.
   Do not invent semantic IDs or retry an uncertain terminal mutation.
3. Wait for the automatic **Callback**. Direct CLI/Desktop Send returns its
   own Watch; terminal-managed Send uses a managed Turn. A terminal fallback may
   also return a Watch. Do not add a duplicate observer to a successful Send.
4. Use **Status** with the exact `turn_id` or `watch_id` when the callback is
   delayed or the Pi route changed.
5. Use **Respond** for a question in that same Turn. Use **Approve** only after
   reviewing the live approval prompt and making an explicit decision.
6. Use **Cancel**, **Close**, **Renew**, or **Retry Callback** only when the
   current list/status output advertises that exact action.

The `/akk` command is the direct human surface. The complete semantic catalog is
also registered for model-driven orchestration:

| Tool | Purpose |
| --- | --- |
| `agent_knock_knock_list` | List discoverable CLI/Desktop conversations and their current capabilities/actions; a visible Desktop entry is not proof of a live connection. |
| `agent_knock_knock_watches` | Inspect recent monitoring records separately (default 24 hours, bounded pagination); active and unresolved records remain visible outside the history window. |
| `agent_knock_knock_watch` | Start a durable, read-only Watch for one exact advertised conversation or terminal. |
| `agent_knock_knock_unwatch` | Stop observation by exact `watch_id`; it does not interrupt the coding agent. |
| `agent_knock_knock_list_resumable_threads` | List structurally verified native threads that can be resumed in one terminal. |
| `agent_knock_knock_native_inspect` | Run the closed native `status` inspection for one exact terminal. Arbitrary slash commands are not accepted. |
| `agent_knock_knock_model_options` | Read one exact idle terminal's native model and reasoning catalog and create a single-use typed offer. |
| `agent_knock_knock_repair_model_control` | Dismiss only an exactly recognized stale model-control surface; it never selects a model or submits a task. |
| `agent_knock_knock_set_model` | Consume the current catalog offer to select one advertised semantic model and reasoning effort. |
| `agent_knock_knock_permission_options` / `agent_knock_knock_set_permissions` | Inspect and change permissions only where the exact target advertises support. |
| `agent_knock_knock_desktop_create` | Create a Codex Desktop conversation in a selected project or explicit directory. |
| `agent_knock_knock_identify_foreground` | Run a bounded diagnostic native identity probe without creating durable model-control authority. |
| `agent_knock_knock_identify_and_send` | Keep one terminal lock across identity observation and one explicit Send when the normal foreground identity is ambiguous. |
| `agent_knock_knock_new_thread` | Start and verify a clean native coding-agent thread after explicit user intent. |
| `agent_knock_knock_reconcile_binding` | Detach one exact conflicting AKK Session binding after explicit confirmation, without adopting another thread. |
| `agent_knock_knock_resume_thread` | Resume one exact complete `native_thread_id` returned by the current discovery result. |
| `agent_knock_knock_status` | Inspect one exact conversation, managed Turn, or Watch. |
| `agent_knock_knock_send` | Send a new task through the exact currently advertised conversation, Session, or terminal action. |
| `agent_knock_knock_respond` | Answer a question or blocked callback in one existing Turn; it does not start a new Turn. |
| `agent_knock_knock_respond_interaction` | Answer the current typed native questionnaire step for one exact response-capable Turn or Watch. |
| `agent_knock_knock_approve` | Approve one current permission request after Pi presents a native user-decision gate. |
| `agent_knock_knock_renew` | Renew the exact supported Watch or managed Turn observation window. |
| `agent_knock_knock_recover` | Perform only the recovery action advertised by the exact target. |
| `agent_knock_knock_retry_callback` | Retry one persisted managed callback with its original message identity. |
| `agent_knock_knock_cancel` | Interrupt one exact task after Pi obtains native confirmation; the shared pane stays open. |
| `agent_knock_knock_close` | Release AKK management for one Turn without sending terminal input or stopping the coding agent. |

Except for the deliberately user-intent-first, read-only Watch path, treat the
fresh `available_actions` output as authority. The connector preserves AKK's
semantic-ID, idempotency, terminal identity, Store, Session, Turn, and
completion rules rather than recreating them in Pi.

## Active approval, response, and cancellation

When a managed task needs permission, its callback is queued into the
originating Pi session. A model-facing `agent_knock_knock_approve` call does not
immediately type into the terminal. The connector first refreshes AKK Status,
shows the current prompt in Pi's native UI, and requires a selection:

- **Approve once** sends the current prompt-scoped AKK approval.
- **Keep pending** sends no terminal input.
- For a managed `turn_id`, **Reject and cancel task** asks for a second
  confirmation, then invokes AKK Cancel.

A terminal-scoped approval has no terminal-scoped Cancel authority, so its
dialog offers only Approve or Keep pending. Direct CLI/Desktop approvals
refresh the exact `conversation_id` or `watch_id` and retain its
`interaction_id`. An explicitly requested native `reject` decision instead
shows **Reject request** / **Keep pending**, then sends that same reviewed
decision. A separately advertised Cancel action gets its own Pi confirmation
dialog.

`agent_knock_knock_respond` answers an ordinary question in the exact
in-flight task; it is not an approval denial. A native rejection is available
only where Status advertises it. The separate **Reject and cancel task**
choice interrupts a managed Turn; it is not a native deny-and-continue action.
A native rejection may also end the coding-agent turn when its current
request offers cancellation. Status reports the observed outcome, including
`interrupted`; denial does not promise that the same turn continues.

The native confirmation flow requires an interactive Pi UI. In a context where
`ctx.hasUI` is false, the connector refuses model-facing Approve and Cancel
instead of mutating the terminal without a person. Headless/non-interactive Pi
is not a product-acceptance target for this POC.

AKK keeps the coding agent's existing permission mode. This connector does not
enable `--yolo`, change a target's permission settings, or expose AKK's
OpenClaw-specific `autoApprove` configuration.

## Callback delivery and recovery

The callback path is:

```text
AKK callback outbox
  -> command_json_v1 callback helper
  -> authenticated private Unix socket
  -> fsync-backed Pi callback inbox
  -> originating Pi session
```

When Pi is idle, the callback is injected with `triggerTurn: true` and starts a
new Pi turn. When Pi is already producing a response, the connector uses Pi's
follow-up queue so the callback is not mixed into the current model turn.
Pi 1.2.0 also reports busy while `before_agent_start` is running, so callbacks
arriving during startup use that same follow-up queue. Idle callback turns now
run Pi's `before_agent_start` handlers with `messageType: "custom"`; other
extensions that inspect user prompts must handle that upstream distinction.

An `accepted` callback acknowledgement means that the connector durably
admitted the exact delivery to its local inbox and returned an acceptance ID.
It does **not** mean the Pi model consumed the message: both supported Pi
versions expose a synchronous `sendMessage()` call without a model-consumption
receipt. The last
hop is therefore at-least-once or uncertain if Pi crashes between
`sendMessage()` and recording the inbox entry as delivered. Delivery and
idempotency IDs let the connector reject collisions and suppress known exact
duplicates.

For a missing callback:

1. If Pi is busy, wait for the current response to end; the callback may be a
   queued follow-up.
2. Refresh `/akk list`, then run `/akk status <turn-selector-or-watch-id>`.
   Status is the authoritative manual recovery path and does not need the
   callback to have reached the model.
3. If a still-live task has no managed callback route, start a new read-only
   Watch using its exact advertised conversation/terminal target and retain the
   returned `watch_id`.
4. Use `agent_knock_knock_retry_callback` only when the current task
   advertises it and the original Pi callback route is still live. Never retry
   an uncertain terminal Send to recover a callback.

The POC owns one live Pi runtime and one branch epoch. Explicit session-tree
navigation rotates the controller route; Pi shutdown removes the socket and
invalidates that runtime's route. The durable inbox does not migrate callbacks
from an old random controller identity into a new Pi runtime or branch. After a
restart or branch change, use fresh List/Status and, for still-running
work, a fresh Watch. Do not expect the old route's callback to jump to the new
conversation automatically.

## Configuration, security, and storage

The connector needs no project-specific configuration. These optional
environment variables must be set **before** Pi starts and must contain
absolute paths:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AKK_PI_STORE_DIR` | `~/.agent-knock-knock/store` | Override AKK's shared Session, Turn, Watch, receipt, and callback-outbox Store. |
| `AKK_PI_STATE_DIR` | `~/.pi/agent/akk` | Override the Pi connector's durable callback-inbox directory. |

Example with isolated development state:

```sh
AKK_PI_STORE_DIR=/absolute/private/path/akk-store \
AKK_PI_STATE_DIR=/absolute/private/path/pi-akk-state \
pi
```

Security and retention boundaries:

- Pi Extensions execute with the same OS privileges as Pi. Review local
  connector source before loading it.
- Each Pi runtime creates a random directory under the OS temporary directory
  with mode `0700`. Its Host Profile and authenticated Unix socket use mode
  `0600`, and the directory is removed on clean Pi shutdown.
- The socket token is random and runtime-private. It is not written to the
  durable inbox or accepted as a model/tool argument. The callback helper is
  allowed only the socket and token environment variables it needs.
- The persistent state directory is forced to `0700`; its
  `callback-inbox.json` is written atomically with mode `0600`. It can retain
  callback bodies, which may contain task results. The inbox is bounded to 256
  entries and 64 MiB, pruning older delivered entries as new callbacks arrive.
- The AKK Store is separate from the Pi inbox and may contain terminal/session
  metadata and callback results. Use a dedicated private directory for either
  override; do not point it at a shared or broad filesystem root.
- The connector strips the supported GLM credential environment variables
  from AKK relay/callback subprocess environments. Model credentials remain
  Pi-owned and are never connector configuration.

## Troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| `requires tested Pi` | Run `pi --version`; this connector accepts `1.2.0` and `0.84.4`. Use `npm install -g @earendil-works/pi-coding-agent@1.2.0` for the current verified release. Other releases are not silently accepted. |
| Pi never shows `AKK ready` | Confirm Node is at least 22.19, run `pi list`, update or reinstall `npm:@scotthuang/agent-knock-knock-pi@next`, and fully restart Pi. For a source checkout, follow the local-development build commands below. |
| Module or `lib/index.js` not found | Remove and reinstall the npm package. For a source checkout, confirm Pi was given `connectors/pi`, not the repository root, and rebuild with the documented cwd-specific command. |
| `/akk list` finds no target | Open an authenticated supported CLI/Desktop session under the same OS user. For terminal-only paths, use tmux/Herdr and leave the process running. |
| Send says the target is ambiguous | Run a fresh `/akk list` and use the exact displayed selector for `/akk`, or the prefilled semantic ID from that row's current tool action. |
| Callback does not appear immediately | Pi may be busy, so the callback is queued as a follow-up. Wait for the current turn, then use fresh List and Status. After a Pi restart or branch change, the old callback route is intentionally not migrated. |
| Approval or cancellation says an interactive UI is required | Use Pi's interactive TUI. The POC deliberately blocks model-facing Approve/Cancel when `ctx.hasUI` is false. |
| Approval changed before confirmation | Refresh Status and review the newly observed prompt. Do not reuse an old approval offer or blindly retry an interrupted approval. |
| Callback socket/profile is unavailable | The owning Pi runtime may have stopped or its temporary private directory may have disappeared. Restart Pi to create a fresh route; recover existing work with List/Status rather than copying socket paths or tokens. |
| State-directory or Store permission error | Both override variables must be absolute and point to dedicated real directories. Stop Pi, inspect ownership and contents, then choose a new private directory if the existing path is unsafe or incompatible. |
| Updated connector still behaves like the old POC | Run `pi update npm:@scotthuang/agent-knock-knock-pi` and fully restart Pi. For a source checkout, re-run `npm ci` and the connector-specific build first. A running Extension is not hot-replaced. |
| Send result is uncertain | Do not automatically send the task again. Inspect Status, the exact pane, or the attached Watch; retrying terminal input could duplicate work. |

## Upgrade and uninstall

Inspect and update the npm installation with Pi's package manager:

```sh
pi list
pi update npm:@scotthuang/agent-knock-knock-pi
```

Use one of the explicitly verified Pi versions (`1.2.0` or `0.84.4`) until
this README declares another accepted version. Do not use an unverified Pi upgrade as a connector update.

Remove the npm package by its package identity:

```sh
pi remove npm:@scotthuang/agent-knock-knock-pi
```

`pi uninstall` is an alias for `pi remove`. Removing the package does not stop
or delete Codex/Claude terminals, model credentials, `~/.pi/agent/akk`, or the
AKK Store. Those durable directories are retained for inspection/recovery and
should be reviewed separately before any manual deletion.

## Development and verification

To load a source checkout for one Pi run, build the connector explicitly:

```sh
AKK_REPO=/absolute/path/to/agent-knock-knock
cd "$AKK_REPO"
npm --prefix connectors/pi ci
npm run pi:build
pi -e "$AKK_REPO/connectors/pi"
```

The equivalent child-package build is:

```sh
cd "$AKK_REPO/connectors/pi"
npm ci
npm run build
```

Do not run a bare root `npm run build` and assume it built this connector. The
unambiguous root command is `npm run pi:build`; inside `connectors/pi`, use
`npm run build`. `pi -e` is temporary and changes no package settings. To
persist a local source path, use `pi install "$AKK_REPO/connectors/pi"`; remove
that same absolute source with `pi remove` when finished.

From the repository root:

```sh
npm run pi:typecheck
npm run pi:test:fast
npm run pi:pack:check
```

Or from `connectors/pi`:

```sh
npm run typecheck
npm run test:fast
npm run pack:check
```

## Release safety

`npm run release:check` is check-only. The shared connector gate proves the
generated Skill hash, package manifest/constants/lock/dependency parity, then
runs typecheck, fast tests, and inspection of the real package tarball. In
release mode it also requires a clean synchronized `main`, verifies that the
exact npm version and `pi-v<version>` repository tag are unused, and rejects
non-publishable runtime dependency specifiers.

Activation also performs a runtime compatibility gate. The pinned AKK
HostAdapter must expose capability handshake v1, whose catalog digest, ordered
tool names and derived count, and canonical Skill digest must match both this
package's generated Skill and the tools Pi just registered. Missing or forged
metadata, an unknown handshake version, or partial registration prevents the
connector from reporting `AKK ready`; no connector-local tool-count literal is
used.

The deterministic local form performs the same package checks without reading
registry or git-remote release state:

```sh
npm run release:check -- --offline
```

From the repository root, `npm run connectors:verify` checks Pi and DeepSeek
Harness independently; it does not require their package versions to match.
Publishing Pi additionally requires explicit version confirmation:

```sh
npm run release:check -- --publish --confirm-version 0.1.0-poc.8
```

Prereleases use npm tag `next`; stable versions use `latest`. Tags and GitHub
Releases use `pi-v<version>` and are created separately after npm verification.

The [PR #266](https://github.com/scotthuang/agent-knock-knock/pull/266)
acceptance record on 2026-08-30 included:

- root fast tests: 1,462/1,462 passed;
- connector fast tests: 23/23 passed;
- root and connector TypeScript typechecks, architecture/evidence validators,
  and connector package dry-run passed;
- a real Claude Code 2.1.251 flow covering Send, approval callback, Pi native
  approval, exact marker execution, completion callback, and delivered Status;
- a real Codex flow in a clean isolated environment covering native
  `agent_accepted`, exact marker execution, Unix Socket callback into Pi, and
  durable high-confidence delivered Status.

The 2026-10-14 compatibility check additionally verified the packaged connector
loads in isolated Pi `1.2.0` and `0.84.4` installations with AKK `0.14.7`. A
real Pi `1.2.0` SDK session with a deterministic local provider verified idle,
`before_agent_start`, and busy-generation callback delivery, native session
recording, duplicate suppression, and rejection of a retired branch route.
This fixture uses the real Pi event loop and connector IPC; it does not claim
a cloud-model or human-driven TUI test. An isolated Codex CLI/backend `0.162.1`
round trip also verified Send, Status, allow-once execution, rejected command
with no file side effect, and typed asynchronous question/answer. The question
completion callback was recorded in the original Pi session and consumed by
the local provider; duplicate delivery added no second message. Approval UI
choices were driven by the authorized test script, not a person clicking the
TUI. The earlier `0.84.4` runtime was package-load checked this round; its full
real coding-task acceptance is the historical record above.

The 2026-10-21 core refresh pins AKK `0.14.15` and verifies its capability
handshake, the full dynamic tool catalog (including the separate Watches
query), every tool schema, and conversation-only List projection. Connector
regressions also retain callback deduplication, busy delivery, and exact route
retirement checks. The real Pi `1.2.0` RPC CLI also loaded the connector in an
isolated home and registered `/akk`, without submitting a model task. These
isolated tests do not repeat the historical live
Codex/Claude task or real-channel delivery acceptance above.

The 2026-10-23 coordinated release pins AKK `0.14.16` and bundles its updated
Skill. Default List folds unnamed, unstarted Codex candidates beside an
established conversation; diagnostic List retains their exact IDs. This is
a presentation change, not evidence that a candidate is disconnected, and it
does not change Send routing or callback ownership. Sole empty conversations
and exact frontend associations remain visible.

Connector **`0.1.0-poc.8`** pins exact AKK **`0.16.0`** and bundles
its synchronized Skill. Core separates managed binding reconciliation from
native Store authority transfer, records Store owner process identities, and
uses a durable transfer journal with evidence-based automatic recovery. Store
writer protocol advances to **11** (format **1**), action contract to **33**,
and List projection to **v4**. The relay's generic 90-second deadline no longer
kills `send`, `delegate`, or `respond` while they are proving text submission;
phase deadlines, explicit timeouts, and Host cancellation remain effective.
Pi Host compatibility and callback ownership are unchanged. This release
adds no new Pi live-model or external-channel acceptance claim. It uses
`next` alongside the coordinated core release.

Connector **`0.1.0-poc.7`** pins AKK **`0.15.0`** and bundles its updated
Skill. Claude Code and configured wrappers such as `tclaude` share the same
adapter. New Claude Sends prefer an exact eligible terminal with managed
completion monitoring and supported approval controls; native inbox fallback
remains available when no controllable terminal counterpart exists. Codex stays
backend-first. Existing task routes, interaction authority, Pi Host compatibility
and callback ownership remain unchanged. This dependency update does not claim
a new Pi live-model or external-channel delivery test. See the
[Claude direct-control guide](../../docs/claude-cli-direct.md) for prerequisites
and operation-specific limits.

Connector **`0.1.0-poc.6`** pins AKK **`0.14.17`** and carries its Codex CLI
`0.164.0` compatibility changes and reviewed Skill. It preserves the Pi Host
version policy, tool protocol and callback ownership. The core
[compatibility matrix](../../docs/codex-0.164.0-compatibility.md) separates
native backend task/approval/question checks from terminal capture regressions
and retained limits. This dependency refresh does not claim a new Pi live-model
or external-channel delivery run.

These are POC acceptance results, not a promise of compatibility with every
future Pi, Codex, Claude Code, tmux, or Herdr release. Version
`0.1.0-poc.8` is an npm prerelease distributed through the `next` dist-tag;
its publication is coordinated with core `0.16.0` and the DSH connector.
ClawHub publication remains a separate channel.

## Deliberate POC limits

The POC intentionally does not provide a standalone Supervisor, multi-Host
leader election, cross-session or cross-branch callback migration, remote
terminal access, Windows named pipes, configuration-driven auto-approval, or
automatic changes to coding-agent permission settings. Available actions come
from AKK's verified target capabilities; installing this connector does not
make an unsupported operation available.

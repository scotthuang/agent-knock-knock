# Agent Knock Knock for Pi — POC

This Pi Extension makes Pi an Agent Knock Knock (AKK) orchestration Host. Pi
can use `/akk` and AKK's 16 semantic tools to control Codex and Claude Code
terminals that are already running in tmux or Herdr.

The connector does not modify Pi, launch or authenticate a coding agent, or
depend on an OpenClaw Gateway. It uses AKK's public HostAdapter and returns
callbacks to the exact initiating Pi session through a private local Unix
socket.

## Status and compatibility

This is a source-only POC. `@scotthuang/agent-knock-knock-pi` is **not
published to npm**; load or install the local directory as described below.

The current compatibility contract is intentionally exact:

- Pi `0.84.4`, installed from the official
  `@earendil-works/pi-coding-agent` package.
- Node.js `22.19.0` or newer.
- AKK `0.12.23`, pinned by this connector's package and lockfile. Running
  `npm ci` in `connectors/pi` installs that exact AKK runtime; a different
  version at the repository root is not substituted automatically.
- macOS or Linux. The POC requires a POSIX Unix socket and does not support
  Windows named pipes.
- At least one authenticated Codex or Claude Code process already running in a
  supported tmux or Herdr terminal under the same OS user.
- A configured Pi model/provider. Pi model authentication is separate from
  AKK and is not performed by this connector.

The connector rejects a Pi runtime other than `0.84.4` before it creates a
socket or starts AKK lifecycle work. Pi's own packages remain `*` peer
dependencies as required by Pi's package contract; the runtime check is the
compatibility authority.

## Five-minute quick start

### 1. Install the accepted Pi version

```sh
npm install -g @earendil-works/pi-coding-agent@0.84.4
node --version
pi --version
```

Configure a model using Pi's normal `/login`, provider environment variable,
or settings flow before continuing.

### 2. Start a coding agent in a shared terminal

AKK discovers an existing process; it never starts one for you. For example:

```sh
tmux new-session -s akk-pi-work -c "$(pwd -P)" codex
```

Wait for Codex to reach its interactive prompt, then detach with `Ctrl-b`
followed by `d`. Use `claude` instead of `codex` to test Claude Code. An
existing supported Herdr terminal works too.

### 3. Build the local connector

From the **agent-knock-knock repository root**, run:

```sh
AKK_REPO=/absolute/path/to/agent-knock-knock
cd "$AKK_REPO"
npm --prefix connectors/pi ci
npm run pi:build
```

Alternatively, run the child-package commands from its own directory:

```sh
cd "$AKK_REPO/connectors/pi"
npm ci
npm run build
```

Do not run a bare root `npm run build` and assume it built this connector. The
unambiguous root command is `npm run pi:build`; inside `connectors/pi`, use
`npm run build`.

### 4. Load it for one Pi run

```sh
pi -e "$AKK_REPO/connectors/pi"
```

Pi should show `AKK ready`. `-e` is temporary and changes no Pi package
settings. To persist the same local source path instead:

```sh
pi install "$AKK_REPO/connectors/pi"
pi
```

### 5. Complete the first round trip

In Pi, list the live targets:

```text
/akk list
```

If exactly one terminal is send-ready, submit a small task:

```text
/akk reply with exactly AKK_PI_OK after inspecting the current workspace
```

If multiple targets are present, use the fresh selector printed by
`/akk list`:

```text
/akk @a1b2c3d4: reply with exactly AKK_PI_OK after inspecting the current workspace
```

A managed Send returns a `turn_id`; when the coding agent settles, its callback
is injected into the same Pi session. Inspect it at any time with the exact
turn selector printed by AKK:

```text
/akk status <turn-selector>
```

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

1. **List** to discover live terminals and their current `available_actions`.
2. **Send** using the fresh action's prefilled `session_id` or `terminal_id`.
   Do not invent semantic IDs or retry an uncertain terminal mutation.
3. Wait for the managed **Callback**. An unmanaged user-priority fallback may
   return a Terminal Watch callback instead of a managed Turn callback.
4. Use **Status** with the exact `turn_id` or `watch_id` when the callback is
   delayed or the Pi route changed.
5. Use **Respond** for a question in that same Turn. Use **Approve** only after
   reviewing the live approval prompt and making an explicit decision.
6. Use **Cancel**, **Close**, **Renew**, or **Retry Callback** only when the
   current list/status output advertises that exact action.

The `/akk` command is the direct human surface. The following 16 tools are also
registered for model-driven orchestration:

| Tool | Purpose |
| --- | --- |
| `agent_knock_knock_list` | List verified Codex/Claude terminals, managed work, Watches, and currently available semantic actions. |
| `agent_knock_knock_watch` | Start a durable, read-only Watch for one exact `terminal_id`. |
| `agent_knock_knock_unwatch` | Stop observation by exact `watch_id`; it does not interrupt the coding agent. |
| `agent_knock_knock_list_resumable_threads` | List structurally verified native threads that can be resumed in one terminal. |
| `agent_knock_knock_native_inspect` | Run the closed native `status` inspection for one exact terminal. Arbitrary slash commands are not accepted. |
| `agent_knock_knock_new_thread` | Start and verify a clean native coding-agent thread after explicit user intent. |
| `agent_knock_knock_reconcile_binding` | Detach one exact conflicting AKK Session binding after explicit confirmation, without adopting another thread. |
| `agent_knock_knock_resume_thread` | Resume one exact complete `native_thread_id` returned by the current discovery result. |
| `agent_knock_knock_status` | Inspect one exact managed Turn or Terminal Watch. |
| `agent_knock_knock_send` | Send a new task through the exact currently advertised Session or terminal action. |
| `agent_knock_knock_respond` | Answer a question or blocked callback in one existing Turn; it does not start a new Turn. |
| `agent_knock_knock_approve` | Approve one current permission request after Pi presents a native user-decision gate. |
| `agent_knock_knock_renew` | Renew monitoring for one stalled but still-live Turn without terminal input. |
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
dialog offers only Approve or Keep pending. A separately advertised Cancel
action gets its own Pi confirmation dialog.

`agent_knock_knock_respond` answers an ordinary question in the exact
in-flight Turn; it is not an approval denial. AKK currently has no generic
"select the target's No option and continue this Turn" tool. Reject-and-cancel
interrupts the task instead.

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

An `accepted` callback acknowledgement means that the connector durably
admitted the exact delivery to its local inbox and returned an acceptance ID.
It does **not** mean the Pi model consumed the message: Pi `0.84.4` exposes a
synchronous `sendMessage()` call without a model-consumption receipt. The last
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
   Watch on its exact current `terminal_id` and retain the returned `watch_id`.
4. Use `agent_knock_knock_retry_callback` only when the current managed Turn
   advertises it and the original Pi callback route is still live. Never retry
   an uncertain terminal Send to recover a callback.

The POC owns one live Pi runtime and one branch epoch. Explicit session-tree
navigation rotates the controller route; Pi shutdown removes the socket and
invalidates that runtime's route. The durable inbox does not migrate callbacks
from an old random controller identity into a new Pi runtime or branch. After a
restart or branch change, use fresh List/Status and, for still-running terminal
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
pi -e "$AKK_REPO/connectors/pi"
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
| `requires Pi 0.84.4` | Run `pi --version`, then reinstall the exact accepted release with `npm install -g @earendil-works/pi-coding-agent@0.84.4`. Newer Pi releases are not silently accepted by this POC. |
| Pi never shows `AKK ready` | Confirm Node is at least 22.19, run `npm --prefix connectors/pi ci` and `npm run pi:build` from the repository root, then load the absolute `connectors/pi` path. A bare root `npm run build` does not build the child package. |
| Module or `lib/index.js` not found | The local package has not been built, or Pi was given the repository root instead of the `connectors/pi` directory. Rebuild with one of the two documented cwd-specific command sets. |
| `/akk list` finds no terminal | Start authenticated `codex` or `claude` inside supported tmux/Herdr under the same OS user and leave the process running. The connector never launches it. |
| Send says the target is ambiguous | Run a fresh `/akk list` and use the exact displayed selector for `/akk`, or the prefilled semantic ID from that row's current tool action. |
| Callback does not appear immediately | Pi may be busy, so the callback is queued as a follow-up. Wait for the current turn, then use fresh List and Status. After a Pi restart or branch change, the old callback route is intentionally not migrated. |
| Approval or cancellation says an interactive UI is required | Use Pi's interactive TUI. The POC deliberately blocks model-facing Approve/Cancel when `ctx.hasUI` is false. |
| Approval changed before confirmation | Refresh Status and review the newly observed prompt. Do not reuse an old approval offer or blindly retry an interrupted approval. |
| Callback socket/profile is unavailable | The owning Pi runtime may have stopped or its temporary private directory may have disappeared. Restart Pi to create a fresh route; recover existing work with List/Status rather than copying socket paths or tokens. |
| State-directory or Store permission error | Both override variables must be absolute and point to dedicated real directories. Stop Pi, inspect ownership and contents, then choose a new private directory if the existing path is unsafe or incompatible. |
| Updated source still behaves like the old POC | Re-run `npm ci` and the connector-specific build, then fully restart Pi. A running Extension is not hot-replaced. |
| Send result is uncertain | Do not automatically send the task again. Inspect Status, the exact pane, or the attached Watch; retrying terminal input could duplicate work. |

## Upgrade and uninstall

Because the connector is not published, a local-path update means updating the
repository, reinstalling its locked dependencies, rebuilding, and restarting
Pi:

```sh
cd "$AKK_REPO"
git pull --ff-only
npm --prefix connectors/pi ci
npm run pi:build
```

Keep Pi at exactly `0.84.4` until this README declares another accepted
version. Do not use an unverified Pi upgrade as a connector update.

For a persistent local-path installation, first identify the exact source and
then remove that same source:

```sh
pi list
pi remove /absolute/path/to/agent-knock-knock/connectors/pi
```

`pi uninstall` is an alias for `pi remove`. A one-run `pi -e` load needs no
uninstall; exiting Pi stops it. Removing the package does not stop or delete
Codex/Claude terminals, model credentials, `~/.pi/agent/akk`, or the AKK Store.
Those durable directories are retained for inspection/recovery and should be
reviewed separately before any manual deletion.

## Development and verification

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

These are POC acceptance results, not a promise of compatibility with every
future Pi, Codex, Claude Code, tmux, or Herdr release. No npm release was made.

## Deliberate POC limits

The POC intentionally does not provide a standalone Supervisor, multi-Host
leader election, cross-session or cross-branch callback migration, remote
terminal access, Windows named pipes, configuration-driven auto-approval, or
coding-agent `--yolo` adaptation. It controls only the Codex and Claude Code
terminal surfaces already supported by AKK.

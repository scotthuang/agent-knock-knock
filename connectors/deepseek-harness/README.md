# Agent Knock Knock for DeepSeek Harness

This package is the native DeepSeek Harness Web connector for Agent Knock
Knock (AKK). When the Web Host mounts the bundle, it adds `/akk` and the 16 AKK
semantic tools to every live Agent. There is no `/akk-bind` step and no session
id for the user to copy.

The connector is developed in the AKK repository but is an independent npm
package. It does not modify DeepSeek Harness and has its own version, build,
tests, lockfile, bundle manifest, and connector-specific release tag.

## Compatibility

This prerelease supports DeepSeek Harness `0.1.1-rc.2` and `0.1.2-alpha.1` on
the resident Web Host and Node.js `>=22.19.0`. Activation locates the real
`@deepseek-ai/dsh` launcher and requires that launcher plus its `dsh-base`,
`dsh-agent`, `dsh-commands`, `dsh-llm`, and `dsh-tools` packages to form one
coherent set at either reviewed version. An unsupported, missing, or split Host
fails before mounting. The detected launcher version is also projected into the
private AKK Host Profile instead of being replaced with a connector build-time
version. Runtime message and schema helpers are imported from that verified
Host package tree, so a source checkout's development dependencies cannot
replace them.

Headless/one-shot Harness processes, Host-exit callback continuity, and Windows
named pipes are not supported in this release. AKK discovers existing Codex and
Claude Code processes in tmux or Herdr; this connector does not start those
processes or create terminal panes.

## Five-minute quick start

### 1. Check the prerequisites

The Web Host must be one of the two supported DeepSeek Harness releases, Node
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

Make sure at least one Codex or Claude Code process is already running inside a
tmux or Herdr pane, then enter:

```text
/akk list
```

The result should contain that live terminal and the actions currently safe for
it. AKK never asks callers to invent identifiers: copy only the complete
`terminal_id`, `session_id`, `turn_id`, `watch_id`, or `native_thread_id`
returned by AKK.

### 4. Send one task and receive its callback

If exactly one matching terminal is send-ready, this is a complete smoke test:

```text
/akk codex: Inspect package.json and report the package name. Do not modify files.
```

Use `claude:` instead when testing Claude Code. With multiple matching panes,
run `/akk list` first and use the displayed session selector, or let the Agent
call `agent_knock_knock_send` with the exact semantic identifier in that row's
advertised action.

An accepted managed Send creates a `turn_id`. When the coding agent finishes,
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
behavior as 16 structured tools:

| Tool | Purpose |
| --- | --- |
| `agent_knock_knock_list` | List live Codex/Claude terminals, managed state, Terminal Watches, and each row's currently available actions. |
| `agent_knock_knock_watch` | Start durable, read-only observation of one exact `terminal_id`. |
| `agent_knock_knock_unwatch` | Stop one exact `watch_id` without sending terminal input. |
| `agent_knock_knock_list_resumable_threads` | List structurally verified native threads for one terminal. |
| `agent_knock_knock_native_inspect` | Run only the adapter-owned native `status` inspection advertised for an idle terminal. |
| `agent_knock_knock_new_thread` | Start and verify a clean native coding-agent thread after explicit user intent. |
| `agent_knock_knock_reconcile_binding` | Detach one proven stale conflicting binding after explicit confirmation; it neither sends work nor adopts a thread. |
| `agent_knock_knock_resume_thread` | Resume one complete `native_thread_id` from a fresh resumable-thread listing. |
| `agent_knock_knock_status` | Inspect one AKK `turn_id` or Terminal Watch `watch_id` plus a bounded current screen. |
| `agent_knock_knock_send` | Send a new task through the exact action advertised by `list`. |
| `agent_knock_knock_respond` | Answer a question or unblock one existing managed Turn; it does not create a new Turn. |
| `agent_knock_knock_approve` | Approve the current exact permission request once, only after human review and confirmation. |
| `agent_knock_knock_renew` | Renew monitoring for a still-live stalled Turn without typing into the terminal. |
| `agent_knock_knock_retry_callback` | Retry one persisted failed callback with its original message and delivery identity. |
| `agent_knock_knock_cancel` | Interrupt one exact active Turn while leaving the shared pane open. |
| `agent_knock_knock_close` | Release AKK management of a Turn without terminal input, process interruption, or pane closure. |

The ordinary closed loop is:

1. Call `list` and select one exact terminal row.
2. Use only that row's advertised `send` action and semantic identifier.
3. Retain the returned `turn_id` for managed delivery, or the `watch_id` from an
   automatic physical-Send fallback. Completion or attention callbacks return
   to the originating DeepSeek Harness Agent.
4. For a managed question or blocked callback, use `respond` with its `turn_id`.
   For a permission request, follow the approval procedure below.
5. Use `status` when a callback is late or uncertain. Use an explicit `watch`
   for other work that was not sent as a managed AKK Turn.

Do not cache `available_actions` or private terminal state. Refresh `list` or
`status` before a mutation, and never blindly retry an uncertain Send,
approval, cancel, native inspection, or native thread transition.

## Active approval

The DeepSeek Harness connector registers AKK's approval tool directly; unlike
the Pi connector, this prerelease does **not** add a Host-native confirm/select
dialog around that tool. Explicit human confirmation is therefore a required
calling contract for the Agent and user, not a UI gate enforced by this
connector. With the default configuration, the manual flow is:

1. Receive the approval callback, then call
   `agent_knock_knock_status({turn_id})` to refresh the exact current request and
   terminal screen.
2. Present the current request, tool name, and relevant arguments to the user.
3. Obtain an explicit approve or reject decision in the same Web conversation.
4. Only for an explicit approval, invoke the currently advertised
   `agent_knock_knock_approve({turn_id})`, or let the user enter
   `/akk approve <turn-selector>`.
5. If approval was interrupted or returned an uncertain result, refresh status
   and let the human inspect the live TUI. Never retry it blindly.

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

- If the exact Agent and Host are still live, inspect the `turn_id` with
  `status`. A persisted callback failure can be retried with
  `agent_knock_knock_retry_callback`; AKK reuses the original callback message
  id and Turn identity for idempotent delivery.
- For a Terminal Watch, inspect its `watch_id` with `status`. If the route is no
  longer valid, `unwatch` it and start a fresh Watch from a current `list` row.
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
| `/akk list` finds no terminals | Start or locate a real Codex/Claude Code process inside tmux or Herdr. AKK never launches the coding agent or creates its pane. |
| A mutation is absent or rejected | Refresh `/akk list` or structured `list` and use only the action currently advertised for that exact row. Resolve a current approval first when it blocks input. Do not reuse stale IDs or action payloads. |
| The callback never appears | Run `/akk status <turn-or-watch-id>`. If the same route is live, use the persisted `retry_callback` tool for a failed Turn callback. After a Host restart or Agent replacement, old delivery fails closed; recreate a Watch or start new work from the current Agent. |
| Callback delivery reports IPC unavailable or timeout | Keep the originating Web Host alive and inspect whether it was restarted or disposed. The socket is Host-process-private and has an eight-second callback boundary; there is no cross-process fallback route. |
| A Watch completed but its callback was missed | Query `status` by `watch_id`. Under a new Host incarnation, unwatch the old record and create a fresh Watch from a current terminal row. |
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
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.2
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
tests against its pinned published AKK runtime `0.12.22`; building the current
repository root does not silently replace that dependency. Testing connector
changes against another AKK runtime requires an explicit dependency change and
compatibility review rather than an implicit local link.

## Tests and release status

The package manifest is currently `0.1.0-rc.2`, so this remains a prerelease. As
of 2026-08-30, npm has published `0.1.0-rc.2` under `next`; `latest` still points
to `0.1.0-rc.1`. Registry state can change independently of this source file, so
the `npm view` commands above remain authoritative.

From `connectors/deepseek-harness`, the normal development gate is:

```sh
npm ci
npm run typecheck
npm run test:fast
npm run pack:check
```

These commands typecheck the connector, run its fast wiring/profile/IPC/schema
tests, and inspect the package tarball. They do not publish anything. The
`0.1.0-rc.2` compatibility work was additionally typechecked and runtime-smoked
against the official DeepSeek Harness `0.1.2-alpha.1` source release. Its npm
artifacts were not present on the public registry at that validation point, so
the reproducible development lock remains on `0.1.1-rc.2` while peer and runtime
checks admit both reviewed Host versions.

## Release safety

`npm run release:check` is check-only. The script rejects a dirty tree, a
non-`main` branch, an unsynchronized upstream, an existing npm version, and any
runtime `file:`, `link:`, or `workspace:` dependency.

Publishing additionally requires both explicit flags:

```sh
npm run release:check -- --publish --confirm-version 0.1.0-rc.2
```

Prereleases use npm tag `next`; stable versions use `latest`. Repository tags
and GitHub Releases use the connector-specific namespace
`deepseek-harness-v<version>` and are created separately after npm verification.

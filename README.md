# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![CI](https://github.com/scotthuang/agent-knock-knock/actions/workflows/ci.yml/badge.svg)](https://github.com/scotthuang/agent-knock-knock/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Agent Knock Knock lets OpenClaw control local Codex and Claude Code through shared tmux terminals, so you can take over and hand work back without losing context.

**No hooks. No agent-side plugins. Just share a terminal and stay in control. No YOLO. Automate the trusted. Review the rest.**

## Quick Start with ClawHub

AKK reuses Codex or Claude Code already running in tmux; it never launches a coding agent. You need OpenClaw `2026.6.5`+, tmux, and an authenticated `codex` or `claude` CLI, all running as the same OS user.

Install AKK and restart the Gateway:

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

Start the shared coding-agent terminal from the project you want it to work on:

```bash
cd /absolute/path/to/project
tmux new-session -s akk-work -c "$(pwd -P)" codex
```

Use `claude` instead of `codex` if preferred. Wait for the coding agent's idle prompt, then detach from tmux with `Ctrl-b`, followed by `d`.

From any configured OpenClaw channel, first send:

```text
/akk doctor
```

After doctor reports `AKK doctor: ready`, send a separate message:

```text
/akk inspect this repository and summarize it
```

The second command proves that AKK can find the one eligible idle pane, revalidate its process and pane identity, confirm that their working directories match, send the task, and return the result. Direct `/akk ...` commands need no OpenClaw tool-policy changes.

## See It in Action

[![AKK orchestrating a Claude Code-to-Codex handoff through tmux](https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/docs/assets/akk-tmux-handoff-demo.gif)](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/assets/akk-tmux-handoff-demo.mp4)

*OpenClaw asks Claude Code to write a file, waits for AKK to report completion, then hands the result to Codex. Both terminals remain available for direct human control. AKK keeps the agents' existing permission settings. Click the preview to watch in full quality.*

## Use Cases

**Delegate from anywhere.** Use any configured OpenClaw channel to hand work to a local coding agent while you are away from your computer. AKK reports when the agent needs attention or finishes, and you can continue from chat or the shared terminal.

**Orchestrate specialist agents.** OpenClaw can coordinate handoffs: Claude Code can plan, Codex can implement, and Claude Code can review. At any point, you can take over the live terminal, keep working yourself, then hand the same task back to OpenClaw with its context intact.

![Agent Knock Knock cover: OpenClaw knocking on coding agents' door](docs/assets/agent-knock-knock-cover.jpg)

## How It Works

AKK connects OpenClaw to Codex or Claude Code already running inside tmux:

1. OpenClaw sends a task or follow-up through the AKK plugin.
2. AKK finds an eligible agent pane and writes only the user-facing task into that terminal.
3. AKK monitors the same pane for reliable approval, completion, cancellation, and failure evidence.
4. AKK reports the result to the originating OpenClaw conversation.
5. A human can attach to the same tmux session at any time and continue directly.

AKK is local-first. It has no hosted control plane or telemetry and does not change the coding agent's configured permission mode.

## Optional: Natural-Language Delegation

The quick start uses direct `/akk ...` commands, which bypass the model and work without plugin tool access. To let OpenClaw decide to use AKK from a natural-language request, grant the optional `agent-knock-knock` tools in the applicable tool policy.

If you use the default `coding` profile and do not already have `tools.allow`, add AKK without replacing the profile:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["agent-knock-knock"]
  }
}
```

If your configuration already has a restrictive `tools.allow` list, add `"agent-knock-knock"` to that existing list instead. Do not set `allow` and `alsoAllow` at the same scope.

Restart the Gateway after changing the tool policy.

## Installation Details

Requirements:

- A Node.js version supported by your OpenClaw release (Node.js 24 LTS is recommended)
- [OpenClaw](https://docs.openclaw.ai/) `2026.6.5` or newer
- `tmux`
- At least one authenticated coding-agent CLI: Codex or Claude Code
- OpenClaw, AKK, tmux, and the coding agent running as the same OS user

| Compatibility layer | Version | Evidence |
| --- | --- | --- |
| Normal OpenClaw installation | `2026.6.5`+ | The packed plugin installs, loads, registers its full runtime, and passes isolated Gateway workflows. Earlier hosts block AKK's expected local process control in their legacy install-time scanner unless an unsafe override is used. |
| Plugin API and Gateway | `2026.5.12`+ | This is the first stable release with `api.session.workflow.enqueueNextTurnInjection`. The adjacent tested boundary, `2026.5.10-beta.2`, lacks that API. |
| Build SDK | `2026.6.5` | The plugin is built against the oldest host supported for normal installation. |

The compatibility suite tests the normal installation floor and the Plugin API boundary with isolated state and the real packed artifact.

ClawHub installs the OpenClaw plugin, bundled AKK skill, and package-local relay CLI together. The plugin always uses that bundled relay, so a stale shell command cannot be selected through plugin configuration. ClawHub does not add the `agent-knock-knock` command to your shell `PATH`. Do not run `install-openclaw` after a ClawHub install; that command belongs to the npm path below.

If you also want standalone shell commands such as `agent-knock-knock doctor`, install the npm package globally without running `install-openclaw`:

```bash
npm install -g @scotthuang/agent-knock-knock
```

Standalone `agent-knock-knock list` and `status` are read-only with respect to managed task state by default. Passing `--reconcile` explicitly enables controlled reconciliation; OpenClaw does this for `/akk list`, `/akk status`, and the corresponding plugin tools.

### Alternative: Install from npm

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --verify
```

`install-openclaw` installs or updates the plugin without replacing unrelated settings, installs the bundled skill, restarts the Gateway at most once, and optionally verifies the runtime chain. It is safe to rerun. Without `--verify`, the result remains unverified rather than claiming readiness. Use `--skill-only` to skip plugin installation; add `--no-restart` to leave an explicit pending-restart state.

If OpenClaw runs from a local checkout or another nonstandard location, pass its CLI explicitly:

```bash
agent-knock-knock install-openclaw --openclaw-bin /path/to/openclaw/openclaw.mjs
```

## Shared Terminal Details

Install tmux on macOS:

```bash
brew install tmux
```

Or on Debian/Ubuntu:

```bash
sudo apt-get install tmux
```

Then start Codex in a shared terminal:

```bash
tmux new-session -s akk-work -c "$(pwd -P)" codex
```

Use `claude` instead of `codex` for Claude Code. Detach with `Ctrl-b`, then `d`. AKK discovers the pane automatically.

Claude tmux support requires no hooks and does not modify Claude Code settings. Hook-free completion monitoring is verified on Claude Code `2.1.198` and `2.1.218`; newer versions remain eligible when their interactive transcripts preserve the required identity and completion structure. Hookless auto-approval is deliberately narrower: approval evidence currently requires Claude Code `2.1.x` at `2.1.198` or later, and other versions fall back to manual handling.

Run the diagnostic:

```bash
agent-knock-knock doctor
```

For a ClawHub-only installation, use:

```text
/akk doctor
```

For one complete first run, follow [Agent Knock Knock in 5 minutes](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/quickstart-tmux.md).

## Usage

AKK discovers verified Codex and Claude Code panes across workspaces. It sends work only to a pane that is already running in tmux and at a verified idle prompt; it never starts a coding agent for you.

If exactly one eligible idle coding-agent pane exists across all workspaces, send a task directly:

```text
/akk inspect this repository and summarize it
```

If more than one pane is available, name the target before the colon:

```text
/akk codex: inspect this repository and summarize it
/akk claude: review the latest commit
/akk @a1b2c3d4: run the focused tests
```

The core command surface is intentionally small:

```text
/akk <task>
/akk <selector>: <message>
/akk list
/akk status [only|latest|codex|claude|@short-ref]
/akk cancel <session-selector>
```

`/akk list` performs a controlled reconciliation across managed tasks, and `/akk status` limits reconciliation to the selected task. This can close task records whose idle retention has elapsed and restore eligible missing monitors, but it does not send terminal input or retry callback delivery. Standalone shell queries are read-only unless `--reconcile` is explicitly passed, and resolving a selector never changes task state.

Selectors fail closed: `only` works only with one actionable target, `latest` requires a unique newest target, and `codex` or `claude` must identify exactly one eligible pane. `AKK list` shows stable short references while JSON output retains the authoritative full IDs. Before every terminal operation, AKK revalidates the expected agent PID and tmux pane identity, then confirms that the process and pane working directories still match; every send also revalidates the idle prompt immediately before typing.

For natural-language tool use, `agent_knock_knock_list` returns an `available_actions` object on rows in `delegated[]` and `terminal_controlled[]`; `tasks[]` remains a compatibility summary. Use only an action shown there, start with its prefilled authoritative arguments, and supply every `missing_required` field. A delegated row's `status` is its task lifecycle, while a terminal-controlled row's `status` only says whether the coding-agent process is alive and its `activity_state` reports the parsed screen state. The legacy `commands` flags have mixed compatibility semantics, are deprecated, and must never drive tool calls; `available_actions` is the only authoritative current-action source. `send` uses `selector`; status, approval, cancellation, renewal, callback retry, and close use `conversation_id`. For an ordinary send, add only `request`—`timeoutSeconds` is not a supported argument, and monitoring limits should be omitted unless the user explicitly asks to change them.

Workspace is not a routing boundary. AKK can list, inspect, and control verified panes across projects; when more than one target matches, use a selector to choose one explicitly.

If no eligible pane exists, AKK stops with setup guidance. If a send is ambiguous, run `/akk list` and retry with the returned `@short-ref`.

## Configuration

AKK works without project-specific plugin configuration. It reads these optional settings from `plugins.entries.agent-knock-knock.config`:

| Option | Default | Purpose |
| --- | --- | --- |
| `storeDir` | `~/.agent-knock-knock/store` | Stable Store root for the compatibility manifest and managed conversations. |
| `openclawBin` | Auto-detected | OpenClaw CLI used for callback delivery. |
| `codexHome` | Auto-detected | Optional Codex home used to identify Codex sessions running in tmux. |
| `idleTimeoutMinutes` | `10080` | Idle retention checked during controlled reconciliation. |
| `agentTimeoutMinutes` | `60` | Terminal inactivity timeout. |
| `agentHardTimeoutMinutes` | `720` | Maximum terminal monitor lifetime. |

Custom `storeDir` values use the same Store structure. AKK initializes a missing or empty directory and refuses a non-empty manifestless directory instead of guessing how to write it.

See [`openclaw.plugin.json`](https://github.com/scotthuang/agent-knock-knock/blob/main/openclaw.plugin.json) for the complete schema.

## Approvals

AKK keeps each coding agent's existing permission mode and reports supported visible approval prompts.

For Claude Code, manual approval is deliberately narrow:

- It is available only for the current AKK-managed turn.
- AKK accepts only an exact, current Bash dialog with the one-time **Yes** choice already highlighted, correlated to one unresolved foreground Bash tool request in the anchored owner-private transcript. Persistent permission choices are rejected.
- When no trusted rule matches, the callback takes the manual path. The user must personally inspect the named tmux pane, explicitly confirm the exact request, and then run `/akk approve @a1b2c3d4 --expected-approval-fingerprint <fresh-fingerprint>` using the fingerprint from that current notification; the hash-only callback is not sufficient for review.
- AKK re-evaluates the evidence and revalidates the process and pane immediately before sending one Enter.

Unknown, stale, changed, ambiguous, or unmanaged dialogs fail closed and must be resolved in the terminal.

Trusted Codex and hookless Claude terminal commands can optionally be auto-approved with a deterministic policy:

```json5
autoApprove: {
  enabled: true,
  rules: [{
    id: "project-read-status",
    agents: ["codex", "claude"],
    workspaces: [
      "/absolute/path/to/project-a",
      "/absolute/path/to/project-b"
    ],
    commands: [["pwd"], ["git", "status"], ["git", "diff", "--stat"]]
  }]
}
```

Place `autoApprove` inside the plugin `config` object. It is disabled by default. Each rule may authorize multiple canonical workspace roots; `autoApprove.rules[].workspaces` is the sole workspace boundary for automatic approval and does not limit pane discovery or manual control. Rules still match only the configured agents and exact argument vectors. Shell composition, substitutions, globs, environment assignments, unparseable commands, and paths outside every authorized root require manual approval. For Claude, the raw command never leaves the local executor; callbacks expose only bounded hashes and opaque request identities.

## Trust and Privacy

AKK has no hosted control plane or telemetry and does not modify coding-agent settings. Its terminal state and logs stay on your machine; Claude approval callbacks omit raw commands, while Codex may include the visible command details OpenClaw needs to present for review.

At startup, AKK only registers its tools and reconciles monitors for existing tasks. It never launches a coding agent; delegation reuses exactly one eligible agent pane that you already started in tmux.

Your task content is still processed by OpenClaw and the coding-agent or model providers you configure. Review agent permissions and keep secrets out of task prompts.

## Troubleshooting

With the global npm CLI installed, start with `agent-knock-knock doctor`. It runs bounded version probes, validates the OpenClaw config, verifies the installed/enabled/loaded plugin and bundled skill, and checks Gateway health separately. For a ClawHub-only installation, use `/akk doctor`.

| Symptom | Action |
| --- | --- |
| No eligible terminal is available | Start Codex or Claude Code inside tmux as the same OS user, then run `AKK list`. |
| The npm installer or callbacks cannot find a local OpenClaw CLI | Set `openclawBin` and pass `--openclaw-bin` to `install-openclaw`. |
| Source changes do not appear | Build, reinstall from the checkout, and restart the Gateway. |
| Terminal task is `stalled` | Inspect `status` and the terminal; use `/akk renew only <minutes>` only when exactly one live stalled task needs more monitoring time. |
| Task is `callback_failed` | Run `/akk retry-callback only` when it is the only actionable failed callback, or use its `@short-ref`. |
| `AKK list` reports an orphaned terminal dispatch | Inspect the named pane first, then run the exact `/akk close ... --expected-message-id ...` recovery command returned by `list`. AKK leaves the coding agent and tmux pane running. |
| Claude permission is not offered through AKK | Resolve unsupported dialogs in the terminal. The AKK path requires the exact supported one-time Bash prompt for the current managed turn. |
| Claude request was not auto-approved | Check `autoApprove.enabled`, the agent, the rule's canonical `workspaces`, and the exact command vector. The request must also have matching current screen and local transcript evidence. |
| Claude monitor becomes `stalled` | Check the Claude version and `status`, then inspect the terminal. Unknown transcript schemas, background work, identity changes, and ambiguous turns intentionally fail closed. |

For local diagnostics:

```bash
agent-knock-knock status --conversation latest --trace
agent-knock-knock list --terminal-debug
```

Credentialed smoke tests stay outside normal CI. From a repository checkout, the tmux smoke requires the exact pane PID and a freshly verified idle pane before sending one real turn:

```bash
npm run build
AKK_RUN_LIVE_TMUX_SMOKE=1 node scripts/smoke-tmux.js --confirm-live --agent codex --target akk-work:0.0 --expected-pane-pid <pid>
```

This command can use coding-agent credentials and may incur cost. Read the warning before opting in.

## Development

```bash
npm run build
npm run typecheck
npm test
```

See [CONTRIBUTING.md](https://github.com/scotthuang/agent-knock-knock/blob/main/CONTRIBUTING.md) for the development and pull request workflow. For local OpenClaw testing, rebuild, run `node dist/src/cli.js install-openclaw`, and restart the Gateway.

### ClawHub Maintainer Release

The package is configured for ClawHub trusted publishing. Dispatch the `ClawHub Publish` workflow from the matching release tag (replace `vX.Y.Z` below); it verifies that tag against `package.json`, derives `beta` versus `latest`, and defaults to a dry run:

```bash
gh workflow run clawhub-publish.yml --ref vX.Y.Z -f dry_run=true
gh workflow run clawhub-publish.yml --ref vX.Y.Z -f dry_run=false
```

## Storage and Logs

Managed state now lives in the stable `~/.agent-knock-knock/store` root. Its manifest prevents an incompatible AKK writer from changing task state. Directories use mode `0700`; state and log files use `0600`.

The manifest checks storage format and writer behavior separately. An unknown `format_version` is not read. When the format is readable but `writer_protocol` differs, normal queries remain available, explicit reconciliation reports `skipped`, and every mutation fails closed before terminal or Gateway side effects.

The former `~/.agent-knock-knock/conversations` directory is left untouched, but AKK `0.7.0` does not read or migrate it. Existing Codex and Claude Code tmux panes remain available through live discovery, while their old AKK task IDs, callback associations, and follow-up records are not carried into the new Store. Compatible future upgrades continue using the stable Store rather than creating a directory per package version.

Runtime logs redact common secrets and default to 14-day retention. Configure storage and logging with `--store-dir`, `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS`; use a dedicated custom log directory.

## Security

Do not open public issues for sensitive security reports. See the [security policy](https://github.com/scotthuang/agent-knock-knock/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE).

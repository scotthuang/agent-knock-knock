# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![CI](https://github.com/scotthuang/agent-knock-knock/actions/workflows/ci.yml/badge.svg)](https://github.com/scotthuang/agent-knock-knock/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.14-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Agent Knock Knock lets you control local Codex and Claude Code from any configured OpenClaw channel, then take over the same live tmux session without losing context. For managed background work, Managed ACP (via ACPX) also supports Cursor.

**Local-first, with no hosted control plane or telemetry. tmux mode keeps the coding agent's existing permission settings; Managed ACP uses a separate background permission model.**

## See It in Action

[![AKK orchestrating a Claude Code-to-Codex handoff through tmux](docs/assets/akk-tmux-handoff-demo.gif)](docs/assets/akk-tmux-handoff-demo.mp4)

*OpenClaw asks Claude Code to write a file, waits for AKK to report completion, then hands the result to Codex. Both terminals remain available for direct human takeover. The demo uses the agents' existing permission settings; AKK does not switch them. Click the preview to watch in full quality.*

## Use Cases

**Delegate from anywhere.** Use any configured OpenClaw channel to hand work to a local coding agent wherever you are. AKK keeps the task running outside the chat, reports when the agent needs input or finishes, and lets you continue from chat or the shared terminal.

**Orchestrate specialist agents.** OpenClaw can coordinate agent handoffs: Claude Code can plan, Codex can implement, and Claude Code can review. In tmux mode, AKK can also automatically approve trusted permission requests under rules you define. At any point, you can take over the shared terminal, keep working yourself, then hand the same task back to OpenClaw—with context intact.

![Agent Knock Knock cover: OpenClaw knocking on coding agents' door](docs/assets/agent-knock-knock-cover.jpg)

## Choose an Execution Mode

| Mode | Best for | Agents | Requires |
| --- | --- | --- | --- |
| **tmux bridge (recommended)** | Share one live CLI session. OpenClaw and a human can hand the task back and forth. | Codex, Claude Code | `tmux` |
| **Managed ACP** | Start background tasks with durable ACP state and callbacks. | Codex, Claude Code, Cursor | [ACPX](https://github.com/openclaw/acpx) |

Install either mode or both. tmux does not require ACPX. Cursor tmux control is [not yet supported](https://github.com/scotthuang/agent-knock-knock/issues/42). AKK can also discover, resume, or fork local Codex sessions; that is a Codex capability, not a third installation mode.

For a complete first run, choose [tmux bridge in 5 minutes](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/quickstart-tmux.md) or [Managed ACPX in 5 minutes](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/quickstart-managed-acpx.md). Both guides use the npm installer so configuration, restart, and verification fit in one copy-paste path.

### Permission Boundaries

The two modes intentionally use different permission models:

- **tmux bridge:** AKK does not change the coding agent's configured permission mode. For supported prompts in an AKK-managed turn, disabled-by-default exact-command rules may auto-approve a trusted request; unmatched or uncertain requests stay manual.
- **Managed ACP:** AKK starts ACPX-backed agents with `--approve-all`; the tmux prompt inspection and exact-command `autoApprove` policy do not apply to this mode. Claude Code may still surface permission requests through ACPX, while some Codex sandbox-sensitive operations fail directly. Keep managed work inside an explicit workspace.

## Install

Core requirements:

- A Node.js version supported by OpenClaw (Node.js 24.15+ on the 24.x line is recommended for the compatibility floor below)
- [OpenClaw](https://docs.openclaw.ai/) Gateway and plugin API `2026.7.1-2` or newer
- At least one authenticated coding agent: Codex, Claude Code, or Cursor

### Install from ClawHub (recommended)

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw config set plugins.entries.agent-knock-knock.config.workspace "$PWD"
openclaw config set plugins.entries.agent-knock-knock.config.defaultAgent codex
openclaw config set plugins.entries.agent-knock-knock.config.mode tmux
openclaw gateway restart
```

ClawHub installs the OpenClaw plugin, bundled AKK skill, and package-local relay CLI together. OpenClaw invokes that bundled CLI directly, but ClawHub does not add the `agent-knock-knock` command to your shell `PATH`. Do not run `install-openclaw` after a ClawHub install; that command belongs to the npm installation path below and would repeat the plugin setup.

If you also want standalone shell commands such as `agent-knock-knock doctor`, install the npm package globally without running `install-openclaw`:

```bash
npm install -g @scotthuang/agent-knock-knock
```

### Install from npm

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --workspace "$PWD" --default-agent codex --mode tmux --verify
```

`install-openclaw` installs or updates the plugin, atomically configures the selected workspace, agent, and mode without replacing unrelated settings, installs the AKK skill template, restarts the Gateway at most once, and optionally verifies the full runtime chain. It is safe to rerun. Without `--verify`, the result remains unverified rather than claiming readiness. Use `--skill-only` to skip plugin installation; add `--no-restart` to leave an explicit pending-restart state.

If OpenClaw runs from a local checkout or another nonstandard location, pass its CLI explicitly:

```bash
agent-knock-knock install-openclaw --openclaw-bin /path/to/openclaw/openclaw.mjs
```

AKK's agent tools are optional and require an explicit OpenClaw tool-policy opt-in. If you use the default `coding` profile and do not already have `tools.allow`, add AKK without replacing the profile:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["agent-knock-knock"]
  }
}
```

If your configuration already has a restrictive `tools.allow` list, add `"agent-knock-knock"` to that existing list instead. Do not set `allow` and `alsoAllow` at the same scope.

Choose one execution mode, or install both.

### Option A: tmux bridge (recommended)

Install tmux on macOS:

```bash
brew install tmux
```

Or on Debian/Ubuntu:

```bash
sudo apt-get install tmux
```

Then start a shared terminal session:

```bash
tmux new -s coding
```

Run `codex` or `claude` inside the tmux session. AKK will discover it automatically when OpenClaw and the coding agent run as the same user.

Claude tmux support requires no hooks and does not modify Claude Code settings. Hook-free completion monitoring is verified on Claude Code `2.1.198` and `2.1.218`; newer versions remain eligible when their interactive transcripts preserve the required identity and completion structure. Hookless auto-approval is deliberately narrower: approval evidence currently requires Claude Code `2.1.x` at `2.1.198` or later, and any other version falls back to manual handling.

### Option B: Managed ACP

Install ACPX:

```bash
npm install -g acpx
```

AKK uses ACPX to start managed Codex, Claude Code, or Cursor sessions from OpenClaw.

Finally, check which modes are ready if the global CLI is installed:

```bash
agent-knock-knock doctor --mode tmux
```

For a ClawHub-only installation, use the package-local chat diagnostic:

```text
/akk doctor tmux
```

### Trust and Privacy

AKK is local-first. It has no hosted control plane or telemetry, does not modify coding-agent settings, and keeps its state, logs, terminal control, and approval decisions on your machine. Sensitive approval commands are never included in callbacks or AKK logs.

Your task content is still processed by OpenClaw and the coding-agent or model providers you configure. Use explicit workspaces, review agent permissions, and keep secrets out of custom callback commands.

## Five-Minute Quick Starts

Choose one complete, copy-paste path:

| Path | Result |
| --- | --- |
| [tmux bridge in 5 minutes](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/quickstart-tmux.md) | Connect OpenClaw to an existing Codex or Claude Code terminal and keep direct human takeover. |
| [Managed ACPX in 5 minutes](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/quickstart-managed-acpx.md) | Start managed Codex, Claude Code, or Cursor background tasks with durable state and callbacks. |

The five-minute paths use the npm installer so installation, configuration, restart, and verification fit in one command. The ClawHub path above remains the OpenClaw-native distribution option and exposes the same package-local `/akk doctor`.

## How It Works

AKK keeps task state outside the chat channel, so OpenClaw can inspect and continue work even where threads are unavailable. OpenClaw remains the orchestrator; AKK supplies the ACP transport, tmux bridge, local state, and callbacks. See the [roadmap](https://github.com/scotthuang/agent-knock-knock/blob/main/ROADMAP.md) for planned work.

## Usage

Use conversational `AKK` prompts on any chat surface. Explicit agent names override the configured default:

```text
AKK Claude: review the latest commit
AKK Cursor: fix the flaky UI test
AKK describe latest
AKK recover only
```

Surfaces with native commands use the same operations:

```text
/akk <task>
/akk list
/akk doctor [tmux|acpx|all]
/akk status [only|latest|codex|claude|cursor|@short-ref]
/akk describe [session-selector]
/akk send <session-selector>: <message>
/akk cancel <session-selector>
/akk renew <session-selector> [minutes]
/akk retry-callback <session-selector>
/akk close <session-selector> [reason]
```

Selectors fail closed: `only` works only with one actionable target, `latest` requires a unique newest target, and an agent name must identify exactly one actionable session. `AKK list` shows stable short references while JSON output retains the authoritative full IDs.

Codex CLI sessions started outside AKK can also be resumed, opened in a terminal, or forked:

```text
AKK takeover Codex <session-id>
AKK terminal takeover Codex <session-id>
AKK fork takeover Codex <session-id>
```

## Configuration

AKK reads these options from `plugins.entries.agent-knock-knock.config`. The npm installer writes them for you; the ClawHub install section shows the equivalent `openclaw config set` commands.

| Option | Default | Purpose |
| --- | --- | --- |
| `defaultAgent` | `codex` | Agent used when a request does not name one. |
| `mode` | `all` | Mode checked by `/akk doctor`: `tmux`, `acpx`, or `all`. |
| `workspace` | OpenClaw process directory | Working directory for delegated tasks. |
| `storeDir` | `~/.agent-knock-knock/conversations` | Conversation state location; relative plugin paths resolve from `workspace`. |
| `openclawBin` | Auto-detected | OpenClaw CLI used for callback delivery. |
| `idleTimeoutMinutes` | `10080` | Time before an idle task is lazily closed. |
| `agentTimeoutMinutes` | `60` | Callback timeout; terminal bridges treat it as an inactivity timeout. |
| `agentHardTimeoutMinutes` | `720` | Maximum terminal bridge monitor lifetime. |

See [`openclaw.plugin.json`](openclaw.plugin.json) for the complete schema and compatibility aliases.

## Approvals

AKK runs ACPX-backed agents with `--approve-all`. Claude Code surfaces permission requests through ACPX, but some Codex sandbox-sensitive operations fail directly. Keep Codex background work inside its workspace, or prefer Claude Code when a task requires ACPX-approved access elsewhere.

For tmux-backed Codex, AKK reports visible approval prompts. Claude approval is deliberately narrower:

- It is available only for the current AKK-managed turn.
- AKK accepts only an exact, current Bash dialog with the one-time **Yes** choice already highlighted, correlated to one unresolved foreground Bash tool request in the anchored owner-private transcript. Persistent permission choices are rejected.
- When no trusted rule matches, the callback takes the manual path. The user must personally inspect the named tmux pane, explicitly confirm the exact request, and then run `AKK approve <@short-ref>`; the hash-only callback is not sufficient for review.
- A disabled-by-default `autoApprove` rule may approve Claude only when its agent, canonical workspace, and exact argument vector all match the freshly re-read local evidence.
- AKK re-evaluates the policy, reserves the one-shot dispatch, recaptures the one-time choice and transcript evidence, and revalidates the process and pane before sending one Enter. A stale, changed, replayed, or uncertain request fails closed and must be resolved in the terminal.

Unknown, stale, changed, ambiguous, or unmanaged dialogs fail closed and must be resolved in the terminal.

Trusted Codex and hookless Claude terminal commands can optionally be auto-approved with a deterministic policy:

```json5
autoApprove: {
  enabled: true,
  rules: [{
    id: "project-read-status",
    agents: ["codex", "claude"],
    workspaces: ["/absolute/path/to/project"],
    commands: [["pwd"], ["git", "status"], ["git", "diff", "--stat"]]
  }]
}
```

Place `autoApprove` inside the plugin `config` object. It is disabled by default and matches only exact argument vectors in configured workspaces. Shell composition, substitutions, globs, environment assignments, unparseable commands, and out-of-workspace paths require manual approval. Rules match arguments, not executable hashes. For Claude, the raw command never leaves the local executor; callbacks expose only bounded hashes and opaque request identities.

## Troubleshooting

With the global npm CLI installed, start with `agent-knock-knock doctor --mode tmux|acpx|all`. It runs bounded version probes, validates the OpenClaw config and AKK workspace, verifies the installed/enabled/loaded plugin and bundled skill, and checks Gateway health separately. For a ClawHub-only installation, use `/akk doctor`.

| Symptom | Action |
| --- | --- |
| The npm installer or callbacks cannot find a local OpenClaw CLI | Set `openclawBin` and pass `--openclaw-bin` to `install-openclaw`. |
| Source changes do not appear | Build, reinstall from the checkout, and restart the Gateway. |
| Terminal bridge task is `stalled` | Inspect `status` and the terminal; use `/akk renew only <minutes>` only when exactly one stalled task needs more monitoring time. |
| ACPX task is `stalled` | Inspect `status --trace`; close and redelegate if the executor cannot continue. |
| Task is `callback_failed` | Run `/akk retry-callback only` when it is the only actionable failed callback, or use its `@short-ref`. |
| Terminal takeover is unavailable | Run Codex or Claude Code inside tmux and check `AKK list` for a `terminal_controlled` entry. |
| Claude permission is not offered through AKK | Use the managed conversation returned by a background send. If the dialog is not the exact supported one-time Bash prompt, resolve it in the terminal. |
| Claude request was not auto-approved | Check `autoApprove.enabled`, `agents: ["claude"]`, the canonical workspace, and the exact command vector. The request must also be a current one-time Bash prompt with matching local transcript evidence from a supported Claude `2.1.x` version. |
| Claude tmux monitor becomes `stalled` | Check the Claude version and `status`, then inspect the terminal. Unknown transcript schemas, background work, identity changes, and ambiguous turns intentionally fail closed. |

For local diagnostics, use:

```bash
agent-knock-knock status --conversation latest --trace
agent-knock-knock list --terminal-debug
agent-knock-knock list --managed-only
```

Codex ACP uses the pinned `@agentclientprotocol/codex-acp` adapter. Override it only with a compatible command through `AKK_CODEX_ACPX_AGENT_COMMAND`.

Credentialed smoke tests stay outside normal CI. From a repository checkout, the ACPX smoke creates a nonce-scoped session and closes it; the tmux smoke requires the exact pane PID and a freshly verified idle pane before sending one real turn:

```bash
AKK_RUN_LIVE_ACPX_SMOKE=1 npm run smoke:acpx -- --confirm-live --agent codex --workspace "$PWD"
AKK_RUN_LIVE_TMUX_SMOKE=1 npm run smoke:tmux -- --confirm-live --agent codex --target akk-work:0.0 --expected-pane-pid <pid>
```

Both commands can use coding-agent credentials and may incur cost. Read the warning before opting in.

## Development

```bash
npm run build                 # compile TypeScript into dist/
npm run typecheck             # check types without writing output
npm test                      # build and run the full test suite
```

See [CONTRIBUTING.md](https://github.com/scotthuang/agent-knock-knock/blob/main/CONTRIBUTING.md) for the development and pull request workflow. For local OpenClaw testing, rebuild, run `node dist/src/cli.js install-openclaw`, and restart the Gateway.

### ClawHub Maintainer Release

The package is configured for ClawHub trusted publishing. Dispatch the `ClawHub Publish` workflow for a release; it derives `beta` versus `latest` from the package version and defaults to a dry run:

```bash
gh workflow run clawhub-publish.yml --ref main -f dry_run=true
gh workflow run clawhub-publish.yml --ref main -f dry_run=false
```

## Storage and Logs

State lives under `~/.agent-knock-knock/`. Directories use mode `0700`; state and log files use `0600`. Runtime logs redact common secrets and default to 14-day retention. Configure storage and logging with `--store-dir`, `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS`; use a dedicated custom log directory.

## Security

Do not open public issues for sensitive security reports. See the [security policy](https://github.com/scotthuang/agent-knock-knock/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE).

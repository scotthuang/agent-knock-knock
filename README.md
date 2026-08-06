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

**Orchestrate specialist agents.** OpenClaw can coordinate handoffs: Claude Code can plan, Codex can implement, and Claude Code can review. At any point, you can take over the live terminal, keep working yourself, then hand the same native session back to OpenClaw with its context intact.

![Agent Knock Knock cover: OpenClaw knocking on coding agents' door](docs/assets/agent-knock-knock-cover.jpg)

## How It Works

AKK connects OpenClaw to Codex or Claude Code already running inside tmux:

1. OpenClaw selects an AKK session and sends the next user-facing request.
2. AKK verifies the bound agent pane, creates a new Turn, and writes only that request into the terminal.
3. AKK monitors the same pane for reliable approval, completion, cancellation, and failure evidence correlated to that Turn.
4. AKK reports the result, `session_id`, and `turn_id` to the originating OpenClaw conversation.
5. A human can attach to the same tmux terminal at any time and continue directly.

AKK is local-first. It has no hosted control plane or telemetry and does not change the coding agent's configured permission mode.

### Terminal, native session, AKK session, and Turn

AKK keeps four identities separate:

```text
tmux terminal / process incarnation
└─ native Codex or Claude Code session
   └─ AKK session (session_id)
      ├─ Turn 1 (turn_id)
      ├─ Turn 2 (turn_id)
      └─ Turn 3 (turn_id)
```

Once an AKK session exists, an ordinary `send(session_id, request)` creates a new `turn_id` while preserving the native coding-agent context. On first attach only, `send` may instead use a discovery selector explicitly named by the user, or the exact `selector` prefilled by an unmanaged raw-terminal row. AKK binds the verified native context to an AKK session before accepting the new Turn. Never infer a selector, copy one from another row, or pass one as `session_id`. The `turn_id` is not a destination for later ordinary sends; it is the exact identity used for status, approval, cancellation, renewal, callback retry, close, and callback correlation. If a Turn is `waiting_for_openclaw`, `respond(turn_id, answer)` supplies the answer inside that same Turn instead of creating another one.

Human-friendly selectors such as `only`, `codex`, `claude`, a terminal ID, or `@short-ref` remain a discovery layer. A natural-language tool call may preserve one only when the user explicitly named it; otherwise use the exact selector returned by `AKK list`, or omit it and require a unique eligible pane. When an AKK session already exists, `AKK list` pre-fills its authoritative `session_id` for send and the exact `turn_id` for managed controls. The same raw terminal row may advertise status, approval, cancellation, or orphan-close with its own prefilled `conversation_id` compatibility selector. Never infer, guess, or reuse compatibility selectors.

Native clear/new/resume operations are explicit lifecycle actions, separate from ordinary Turn creation. A successful new/clear creates a new native thread and AKK Session; resume activates the exact historical native thread and its corresponding Session. Each successful lifecycle transition creates no Turn. The next ordinary send creates the first Turn in the selected context. AKK serializes the transition, verifies the resulting native identity, and advances the terminal binding generation so work and callbacks from the previous context cannot cross the boundary.

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

Standalone `agent-knock-knock list` and `status` are read-only with respect to managed-turn state by default. Passing `--reconcile` explicitly enables controlled reconciliation; OpenClaw does this for `/akk list`, `/akk status`, and the corresponding plugin tools.

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
/akk threads <exact-terminal-id>
/akk new-thread <exact-terminal-id>
/akk clear-thread <exact-terminal-id>
/akk resume-thread <exact-terminal-id> [native-thread-uuid]
/akk status [only|latest|codex|claude|@short-ref]
/akk respond <turn-selector>: <answer>
/akk cancel <turn-selector>
```

`/akk list` performs a controlled reconciliation across managed turns, and `/akk status` limits reconciliation to the selected turn. This can close records whose idle retention has elapsed and restore eligible missing monitors, but it does not send terminal input or retry callback delivery. Standalone shell queries are read-only unless `--reconcile` is explicitly passed, and resolving a selector never changes turn state.

Selectors fail closed: `only` works only with one actionable target, `latest` requires a unique newest target, and `codex` or `claude` must identify exactly one eligible pane. These names and `@short-ref` are human-facing resolution inputs; a natural-language tool call may preserve one explicitly named by the user, but must not infer one. Managed JSON actions contain the authoritative full `session_id` or `turn_id`. For first attach, an unmanaged raw-terminal row's send action may instead contain its own prefilled `selector`; its advertised raw controls may contain that row's prefilled `conversation_id`. Neither compatibility selector may be guessed, copied from another row, or passed in an authoritative ID field. Before every terminal operation, AKK revalidates the expected agent PID and tmux pane identity, then confirms that the process and pane working directories still match; every send also revalidates the idle prompt immediately before typing.

To change native context, first copy the full `terminal_id` from `/akk list`; lifecycle commands do not accept `@short-ref` or loose agent selectors. `/akk threads <exact-terminal-id>` lists exact, same-workspace resume candidates. `/akk resume-thread <exact-terminal-id>` without a UUID shows the same candidates and asks you to choose; with a complete returned UUID it performs the transition. `/akk new-thread` and its human alias `/akk clear-thread` start a clean context. For these slash forms, AKK reads a fresh lifecycle snapshot and immediately supplies its compare-and-swap binding token internally, so you do not copy the token yourself. AKK does not poll bindings in the background: if a recorded owner process exits, the next lifecycle listing can classify that sole historical binding as resumable, and the resume mutation compare-and-swap detaches it before touching the terminal. Live, stale-token, unsupported, busy, ambiguous, active-elsewhere, or unverifiable transitions fail closed. Do not send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, or `/btw`, Claude `/branch`, or any other first-line native slash command as an ordinary task or answer; use an advertised AKK action, express the request in natural language, or enter an unsupported native command manually in tmux.

For natural-language tool use, `agent_knock_knock_list` is terminal-first. Each live pane appears exactly once in `terminals[]`; `process_state` reports whether its coding-agent process is alive and `activity_state` reports the parsed screen state. `managed.session_id` identifies the continuing AKK session, `managed.current_turn` is its optional active Turn, and `managed.recent_turn` is retained history; retained Turns do not occupy the terminal. Pass `all=true` to include older entries in `managed.history`. By default, `unavailable_managed_turns[]` contains attention-needed records whose pane cannot be presented as a live terminal; `all=true` also includes retained unavailable history.

Use only an `available_actions` entry returned in that snapshot, begin with its prefilled authoritative arguments, and supply every `missing_required` field. A managed Session's `send` uses its prefilled `session_id` and creates a new Turn. For first attach only, use a discovery selector explicitly named by the user or the unmanaged raw-terminal row's prefilled `selector`; do not infer or reuse one. `respond` is available only while a Turn is `waiting_for_openclaw`; it uses `turn_id` and keeps the answer inside that Turn. Managed status, approval, cancellation, renewal, callback retry, and close also use the exact `turn_id`. A raw terminal may be controlled only through the exact status, approval, cancellation, or orphan-close action that its own row advertises with a prefilled `conversation_id`; never construct or guess one. For an ordinary send, add only `request`—`timeoutSeconds` is unsupported, and monitoring limits should be omitted unless the user explicitly asks to change them. AKK revalidates availability before every side effect.

The top-level v5 `action_contracts` adds `list_resumable_threads`, `new_thread`, and `resume_thread`. The terminal row advertises `list_resumable_threads` and, when currently safe, `new_thread`. Listing is read-only, takes only the full `terminal_id`, and returns a fresh `expected_binding_token` plus candidate rows; each `resumable=true` candidate row advertises its own `resume_thread` action. The `new_thread` and `resume_thread` mutations require that fresh token, and resume additionally requires the candidate's complete `native_thread_id` and opaque `candidate_token`. Never construct, guess, truncate, combine across snapshots, or reuse those values after another terminal action. A lifecycle result contains Session and native-thread identities but no `turn_id` because no work was sent.

Workspace is not a routing boundary. AKK can list, inspect, and control verified panes across projects; when more than one target matches, use a selector to choose one explicitly.

If no eligible pane exists, AKK stops with setup guidance. If a send is ambiguous, run `/akk list` and retry with the returned `@short-ref`.

## Configuration

AKK works without project-specific plugin configuration. It reads these optional settings from `plugins.entries.agent-knock-knock.config`:

| Option | Default | Purpose |
| --- | --- | --- |
| `storeDir` | `~/.agent-knock-knock/store` | Stable Store root for the compatibility manifest, authoritative managed Sessions, and Turn records. |
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

At startup, AKK only registers its tools and reconciles monitors for existing managed turns. It never launches a coding agent; new work reuses exactly one eligible agent pane that you already started in tmux.

Your task content is still processed by OpenClaw and the coding-agent or model providers you configure. Review agent permissions and keep secrets out of task prompts.

## Troubleshooting

With the global npm CLI installed, start with `agent-knock-knock doctor`. It runs bounded version probes, validates the OpenClaw config, verifies the installed/enabled/loaded plugin and bundled skill, and checks Gateway health separately. For a ClawHub-only installation, use `/akk doctor`.

| Symptom | Action |
| --- | --- |
| No eligible terminal is available | Start Codex or Claude Code inside tmux as the same OS user, then run `AKK list`. |
| The npm installer or callbacks cannot find a local OpenClaw CLI | Set `openclawBin` and pass `--openclaw-bin` to `install-openclaw`. |
| Source changes do not appear | Build, reinstall from the checkout, and restart the Gateway. |
| Terminal Turn is `stalled` | Inspect `status` and the terminal; use `/akk renew only <minutes>` only when exactly one live stalled Turn needs more monitoring time. |
| Turn is `callback_failed` | Run `/akk retry-callback only` when it is the only actionable failed callback, or use its `@short-ref`. |
| `AKK list` reports an orphaned terminal dispatch or lifecycle transition | Inspect the named pane first, then run the exact `/akk close ...` recovery command returned by `list`. It contains exactly one fresh `--expected-message-id ...` or `--expected-transition-id ...` fence; do not construct, substitute, or reuse it. AKK leaves the coding agent and tmux pane running. |
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

Lifecycle-sensitive releases use the stricter native lifecycle gate described
in [CONTRIBUTING.md](CONTRIBUTING.md#native-lifecycle-live-smoke-release-gate).
It runs `A → new B → send in B → exact resume A` against explicitly selected
Codex and Claude panes, and writes redacted evidence bound to the clean checkout's
exact version and commit. It never runs as part of ordinary `npm test`.

## Development

```bash
npm run build
npm run typecheck
npm test
```

See [CONTRIBUTING.md](https://github.com/scotthuang/agent-knock-knock/blob/main/CONTRIBUTING.md) for the development and pull request workflow. For local OpenClaw testing, rebuild, run `node dist/src/cli.js install-openclaw`, and restart the Gateway.

### Maintainer Release

Before creating a release tag from a commit containing this gate, run the native
lifecycle release gate and embed its validated evidence in the annotated tag.
For those tags, both npm and ClawHub publishing reject a lightweight tag or
evidence that is missing, failed, older than 72 hours, incomplete, or bound to a
different package version or commit. See the
[maintainer procedure](CONTRIBUTING.md#native-lifecycle-live-smoke-release-gate)
for the exact commands.

The package is configured for ClawHub trusted publishing. After pushing the
matching annotated release tag (replace `vX.Y.Z` below), dispatch the `ClawHub
Publish` workflow from that tag. It derives `beta` versus `latest` and defaults
to a dry run:

```bash
gh workflow run clawhub-publish.yml --ref vX.Y.Z -f dry_run=true
gh workflow run clawhub-publish.yml --ref vX.Y.Z -f dry_run=false
```

## Storage and Logs

Managed state now lives in the stable `~/.agent-knock-knock/store` root. Its manifest prevents an incompatible AKK writer from changing authoritative Session or Turn state. Directories use mode `0700`; state and log files use `0600`.

The manifest checks storage format and writer behavior separately. An unknown `format_version` is not read. The current writer protocol is 3, and writer protocols 1 and 2 are its supported predecessors: inspection reports either as `upgradeable`. Before the first mutation publishes a protocol-3 manifest, AKK validates the predecessor Turn records, deterministically derives and durably materializes authoritative Session records, and quarantines ambiguous Session bindings instead of routing through them. Existing Turn state and event logs remain unchanged, and the manifest's `created_at` is preserved. Any other writer-protocol mismatch remains readable for normal queries, while explicit reconciliation reports `skipped` and every mutation fails closed before terminal or Gateway side effects.

The former `~/.agent-knock-knock/conversations` directory is left untouched; AKK does not read or migrate it. Existing Codex and Claude Code tmux panes remain available through live discovery, while their old managed-turn IDs, callback associations, and legacy conversation aliases are not carried into the new Store. Compatible future upgrades continue using the stable Store rather than creating a directory per package version.

Runtime logs redact common secrets and default to 14-day retention. Configure storage and logging with `--store-dir`, `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS`; use a dedicated custom log directory.

## Security

Do not open public issues for sensitive security reports. See the [security policy](https://github.com/scotthuang/agent-knock-knock/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE).

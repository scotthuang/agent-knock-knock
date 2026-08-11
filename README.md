# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Agent Knock Knock lets OpenClaw control local Codex and Claude Code through shared tmux or Herdr terminals, so you can take over and hand work back without losing context.

**No hooks. No agent-side plugins. Just share a terminal and stay in control. No YOLO. Automate the trusted. Review the rest.**

## Quick Start with ClawHub

AKK reuses Codex or Claude Code already running in tmux or a supported Herdr session; it never launches a coding agent. You need OpenClaw `2026.6.5`+, a supported terminal host, and an authenticated `codex` or `claude` CLI, all running as the same OS user.

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

Herdr `0.8.0` is also supported as an exact-version local terminal provider. See [Quick Start with Herdr](docs/quickstart-herdr.md).

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

AKK connects OpenClaw to Codex or Claude Code already running inside a supported shared terminal:

1. OpenClaw selects an AKK session and sends the next user-facing request.
2. AKK verifies the bound agent pane, creates a new Turn, and writes only that request into the terminal.
3. AKK monitors the same pane for reliable approval, completion, cancellation, and failure evidence correlated to that Turn.
4. AKK reports the result, `session_id`, and `turn_id` to the originating OpenClaw conversation.
5. A human can attach to the same tmux or Herdr terminal at any time and continue directly.

AKK is local-first. It has no hosted control plane or telemetry and does not change the coding agent's configured permission mode.

### Terminal, native session, AKK session, and Turn

AKK keeps four identities separate:

```text
terminal resource / process incarnation
└─ native Codex or Claude Code session
   └─ AKK session (session_id)
      ├─ Turn 1 (turn_id)
      ├─ Turn 2 (turn_id)
      └─ Turn 3 (turn_id)
```

Once an AKK session exists, an ordinary `send(session_id, request)` is **session-scoped**: it creates a new `turn_id` in that exact native coding-agent context and never silently follows a different thread now visible in the pane. A listed terminal may instead advertise a **terminal-scoped follow-current** send with its exact full `selector` and a fresh `expected_terminal_token`. Using that prefilled action says “continue in whatever verified context the human selected in this pane”; when the old Session is quiescent and the handoff is exact, AKK atomically detaches the old binding, restores or creates the Session for the live native thread, and only then creates the Turn. The token fences the terminal snapshot so a later pane, process, workspace, or native-thread change cannot be adopted by accident. Legacy selector-based first attach remains supported. Never infer a selector or token, copy one from another row, reuse one after another terminal action, or pass a selector as `session_id`. The `turn_id` is not a destination for later ordinary sends; it is the exact identity used for status, approval, cancellation, renewal, callback retry, close, and callback correlation. If a Turn is `waiting_for_openclaw`, `respond(turn_id, answer)` supplies the answer inside that same Turn instead of creating another one.

Human-friendly selectors such as `only`, `codex`, `claude`, a terminal ID, or `@short-ref` remain a discovery layer. A natural-language tool call may preserve one only when the user explicitly named it; otherwise use the exact selector returned by `AKK list`, or omit it and require a unique eligible pane. Normally a managed row pre-fills its authoritative `session_id` for strict continuation. After a human changes the native thread outside AKK, an adoptable row instead pre-fills the exact terminal selector and `expected_terminal_token` for follow-current continuation. Merely observing that mismatch never mutates the Store. AKK advertises the fenced send only when it can prove a single source claim, exact live identity, idle empty composer, and no unresolved Turn, transition, dispatch, or approval. Active, ambiguous, stale, or unverifiable cases remain blocked and require the user to resolve or select the context explicitly. The same raw terminal row may advertise status, approval, cancellation, or orphan-close with its own prefilled `conversation_id` compatibility selector. Never infer, guess, or reuse compatibility selectors or tokens.

An exact human switch while the old Session still has one active Turn is a decision point, not an automatic redirect. In that case the terminal row may expose `handoff_decision` instead of a follow-current send. Its nested `choices.take_over_current.action` is the only authoritative supersede action: after explicit user confirmation, invoke its complete `agent_knock_knock_close` arguments unchanged (`turn_id`, `reason="superseded_by_human_context_switch"`, and `expected_handoff_token`). The snapshot-bound close records the old Turn's disposition and sends no terminal input. Then list again and use only the newly advertised follow-current send; never chain the old token into a send. Choosing `keep_source` changes no AKK state: restore the old native thread in the Codex or Claude TUI, then refresh the list. A completed/changed Turn or another human thread switch makes the decision token stale and requires a fresh decision.

Native clear/new/resume operations requested through AKK are explicit lifecycle actions, separate from ordinary Turn creation. A successful new/clear creates a new native thread and AKK Session; resume activates the exact historical native thread and its corresponding Session. Each successful lifecycle transition creates no Turn. A human may also run native `/clear`, `/new`, `/resume`, or the equivalent directly in the shared terminal. AKK does not forbid that takeover: the next exact, fresh terminal-scoped follow-current send can absorb the human-driven transition when it is safe, while a `session_id` send deliberately remains pinned to its old context. AKK serializes either transition, verifies the resulting native identity, and advances the terminal binding generation so work and callbacks from the previous context cannot cross the boundary. Exact AKK-driven lifecycle profiles are verified for Codex 0.146.0/0.146.1/0.147.0 and Claude Code 2.1.218/2.1.226.

AKK status and native status inspection are different operations. `agent_knock_knock_status` (and `/akk status`) reads AKK Turn state plus a bounded current terminal screen; it does not execute the coding agent's `/status`. When an idle terminal row advertises `native_inspect`, `agent_knock_knock_native_inspect` can execute only its prefilled, version-scoped inspection with the exact `terminal_id`, `inspection="status"`, and fresh `expected_binding_token`. Supported profiles are Codex 0.146.0/0.146.1/0.147.0 and Claude Code 2.1.218/2.1.226. Claude's adapter parses a newly opened Status panel, dismisses that exact panel once, and proves the same pane returned to an idle empty composer. The action creates no Session, Turn, receipt, monitor, or callback. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, arbitrary slash strings, and unsupported versions remain unavailable. In particular, bare Codex `/usage` opens an interactive menu whose later Enter can select an account-side usage-limit reset; do not automate it as a read-only inspection.

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
- At least one supported terminal host: tmux, or local Herdr `0.8.0` (protocol 19)
- At least one authenticated coding-agent CLI: Codex or Claude Code
- OpenClaw, AKK, the selected terminal host, and the coding agent running as the same OS user

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

Standalone `agent-knock-knock list` and AKK `status` are read-only with respect to managed-turn state by default. Passing `--reconcile` explicitly enables controlled reconciliation; OpenClaw does this for `/akk list`, `/akk status`, and the corresponding plugin tools. This AKK status path does not run the coding agent's native `/status`; the separately advertised `native_inspect` action owns that bounded terminal input.

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

AKK discovers both tmux and local Herdr sessions. If a process appears under more than one provider, AKK fails closed instead of guessing which terminal owns it. Remote Herdr sessions and Windows named-pipe transport are not supported yet.

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

Claude tmux support requires no hooks and does not modify Claude Code settings. Hook-free completion monitoring is verified on Claude Code `2.1.198`, `2.1.218`, and `2.1.226`; newer versions remain eligible when their interactive transcripts preserve the required identity and completion structure. Hookless auto-approval is deliberately narrower: approval evidence currently requires Claude Code `2.1.x` at `2.1.198` or later, and other versions fall back to manual handling.

For Herdr, AKK talks directly to each local session's Unix socket. It binds the stable Herdr `terminal_id`, refreshes the current `pane_id` before every operation, verifies the shell/agent process ancestry and cwd, reads the detector screen, and uses the bracketed-paste-aware `pane.send_input` API. Text injection and Enter remain separate operations so AKK can persist and revalidate the dispatch boundary between them.

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

AKK discovers verified Codex and Claude Code panes across workspaces. It sends work only to a pane that is already running in tmux or supported Herdr and at a verified idle prompt; it never starts a coding agent for you.

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
/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id|snapshot-handle]
/akk status [only|latest|codex|claude|@short-ref]
/akk respond <turn-selector>: <answer>
/akk cancel <turn-selector>
```

`/akk list` performs a controlled reconciliation across managed turns, and `/akk status` limits reconciliation to the selected turn. This can close records whose idle retention has elapsed and restore eligible missing monitors, but it does not send terminal input or retry callback delivery. Independently, the running OpenClaw plugin supervises eligible `waiting_for_agent` monitors every five seconds; this liveness pass only restores missing monitors and likewise never retries callback transport. Standalone shell queries are read-only unless `--reconcile` is explicitly passed, and resolving a selector never changes turn state.

Selectors fail closed: `only` works only with one actionable target, `latest` requires a unique newest target, and `codex` or `claude` must identify exactly one eligible pane. These names and `@short-ref` are human-facing resolution inputs; a natural-language tool call may preserve one explicitly named by the user, but must not infer one. Managed JSON actions normally contain the authoritative full `session_id` or `turn_id`. For first attach, an unmanaged raw-terminal row's send action may instead contain its own prefilled `selector`. For a safe human handoff, a terminal row may prefill its exact full `selector` together with `expected_terminal_token`; preserve both exactly to follow the pane's current context. Its advertised raw controls may contain that row's prefilled `conversation_id`. No compatibility selector or token may be guessed, copied from another row, or passed in an authoritative ID field. Before every terminal operation, AKK revalidates the expected agent PID and provider-owned terminal identity, then confirms that the process and pane working directories still match; every send also revalidates the idle prompt immediately before typing.

To ask AKK itself to change native context, first copy the full `terminal_id` from `/akk list`; lifecycle commands do not accept an ordinary-send `@short-ref` or loose agent selector. `/akk threads <exact-terminal-id>` lists exact, same-workspace candidates with a deterministic number, a collision-safe display-only `@short-id`, an opaque snapshot handle, and the complete UUID. `/akk resume-thread <exact-terminal-id>` without a selection shows that list. A complete UUID remains compatible. A number or short ID resolves only against the latest list displayed in the same OpenClaw session, while an opaque handle names its exact snapshot; all expire after five minutes and fail after terminal, process, workspace, binding, candidate-set, or relevant action changes. None is ever passed to Codex or Claude Code as native identity: AKK resolves the saved tuple back to its full UUID and fresh evidence tokens first. `previous` (or `刚才那个`) is advertised only when the current Session's latest committed lifecycle transition identifies exactly one currently verified resumable source; it never guesses from title, recency, or static lineage. `/akk new-thread` and its human alias `/akk clear-thread` start a clean context. AKK does not poll bindings or adopt observed switches in the background: a human-driven switch is adopted only as part of an explicit, fresh terminal-scoped send. If a recorded owner process exits, the next lifecycle listing can classify that sole historical binding as resumable, and the resume mutation compare-and-swap detaches it before touching the terminal. Stale, expired, unsupported, busy, ambiguous, active-elsewhere, or unverifiable transitions fail closed. Do not ask AKK to send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, or `/btw`, Claude `/branch`, or any other first-line native slash command as an ordinary task or answer; use an advertised AKK action, express the request in natural language, or enter an unsupported native command manually in the terminal UI.

To request a native Codex status card or Claude Status panel, first run `agent_knock_knock_list` and use only that terminal row's advertised `native_inspect` action. The structured tool schema is closed to `inspection="status"`; callers cannot provide `/status` or another slash command as text. AKK serializes the inspection with terminal mutations, revalidates the fresh token and exact terminal identity, and returns only after it proves one fresh bounded status result and an idle postcondition. Codex status probes additionally require an exact viewport large enough to preserve the full Session UUID, cross the versioned paste-settle boundary, and dispatch Enter exactly once. An initially narrow or unknown viewport fails before text input with a widen/zoom diagnostic; post-injection viewport or composer drift fails closed before Enter and leaves the draft for manual inspection. For Claude, the inspection safely dismisses the exact modal once. It never turns ordinary `send` or `respond` into a slash-command escape hatch.

The top-level v10 `action_contracts` documents this closed inspection alongside the existing lifecycle and Turn actions. `available_actions` remains the authority for ordinary current actions. Two deliberate nested exceptions require explicit user confirmation: an active human-handoff conflict may expose the snapshot-bound `handoff_decision.choices.take_over_current.action`, while a collateral terminal-wide unresolved Turn may appear in `blocking_turns[]` with its exact Store-only `recovery_action`. An active handoff source Turn is never generically closable through `blocking_turns`; it remains governed only by the snapshot-bound handoff decision. Copy only the complete listed action, then refresh the list before doing anything else.

For natural-language tool use, `agent_knock_knock_list` is terminal-first. Each live pane appears exactly once in `terminals[]`; `process_state` reports whether its coding-agent process is alive and `activity_state` reports the parsed screen state. `managed.session_id` identifies the continuing AKK session, `managed.current_turn` is its optional active Turn, and `managed.recent_turn` is retained history; retained Turns do not occupy the terminal. A human-driven native-thread mismatch remains honestly classified as `management_state="conflict"`; its `handoff_state` is `external_handoff_adoptable` only when the row advertises the fenced follow-current `send`, otherwise it is `external_handoff_blocked`. Listing never performs the adoption. Pass `all=true` to include older entries in `managed.history`. By default, `unavailable_managed_turns[]` contains attention-needed records whose pane cannot be presented as a live terminal; `all=true` also includes retained unavailable history.

Use only an `available_actions` entry returned in that snapshot, begin with its prefilled authoritative arguments, and supply every `missing_required` field. The only additional action sources are a terminal row's nested `handoff_decision.choices.take_over_current.action` and an exact `blocking_turns[].recovery_action`; both require explicit user confirmation and must be copied whole. A managed Session's strict `send` uses its prefilled `session_id` and creates a new Turn only in that Session's native context. A terminal-scoped follow-current `send` instead carries the selected row's exact full `selector` and `expected_terminal_token`; preserve both and add only `request`. This is the safe path for continuing after a human changed threads directly in the pane. Legacy first attach may still use a discovery selector explicitly named by the user or the unmanaged raw-terminal row's prefilled `selector`; do not infer or reuse one. `respond` is available only while a Turn is `waiting_for_openclaw`; it uses `turn_id` and keeps the answer inside that Turn. Managed status, approval, cancellation, renewal, callback retry, and close also use the exact `turn_id`. Native inspection instead uses the exact terminal row's `terminal_id`, closed `inspection`, and snapshot-bound `expected_binding_token`; do not substitute AKK status or ordinary send. A raw terminal may be controlled only through the exact status, approval, cancellation, or orphan-close action that its own row advertises with a prefilled `conversation_id`; never construct or guess one. `timeoutSeconds` is unsupported, and monitoring limits should be omitted unless the user explicitly asks to change them. AKK revalidates availability before every side effect.

The top-level v10 action contracts include `send`, `native_inspect`, `list_resumable_threads`, `new_thread`, `resume_thread`, and the conflict-only `reconcile_binding` recovery action. `send` has two deliberately different managed scopes: `session_id` is strict context, while the exact terminal `selector` plus `expected_terminal_token` is follow-current context. A supported idle Codex or Claude Code terminal may advertise `native_inspect` with its exact terminal ID, the closed `status` inspection kind, and a fresh binding token. The terminal row also advertises `list_resumable_threads` and, when currently safe, `new_thread`. Thread listing is read-only with respect to Session/Turn state, takes only the full `terminal_id`, and returns a fresh `expected_binding_token` plus candidate rows; each `resumable=true` row retains its complete UUID and exact prefilled `resume_thread` action. If `previous` is present, use only its exact prefilled action for a natural-language “刚才那个” request. Numbers, short IDs, and handles are human display/navigation aids, never tool arguments or authoritative native identity. The `new_thread` and `resume_thread` mutations require the fresh token, and resume additionally requires the candidate's complete `native_thread_id` and opaque `candidate_token`. `reconcile_binding` remains a low-level compatibility/recovery action for a safely detachable conflict when no ordinary follow-current send is appropriate; it never adopts the replacement thread, sends terminal input, or creates a Turn. Never construct, guess, truncate, combine across snapshots, or reuse those values after another terminal action. Native inspection and lifecycle results contain no `turn_id` because no work was sent.

Workspace is not a routing boundary. AKK can list, inspect, and control verified panes across projects; when more than one target matches, use a selector to choose one explicitly.

If no eligible pane exists, AKK stops with setup guidance. If a send is ambiguous, run `/akk list` and retry with the returned `@short-ref`.

## Configuration

AKK works without project-specific plugin configuration. It reads these optional settings from `plugins.entries.agent-knock-knock.config`:

| Option | Default | Purpose |
| --- | --- | --- |
| `storeDir` | `~/.agent-knock-knock/store` | Stable Store root for the compatibility manifest, authoritative managed Sessions, and Turn records. |
| `openclawBin` | Auto-detected | OpenClaw CLI used for callback delivery. |
| `codexHome` | Auto-detected | Optional Codex home used to identify Codex sessions running in a supported terminal. |
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
- When no trusted rule matches, the callback takes the manual path. The user must personally inspect the named terminal pane, explicitly confirm the exact request, and then run `/akk approve @a1b2c3d4 --expected-approval-fingerprint <fresh-fingerprint>` using the fingerprint from that current notification; the hash-only callback is not sufficient for review.
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

At startup, AKK registers its tools and reconciles monitors for existing managed turns. While the OpenClaw Gateway remains healthy, its single-flight supervisor schedules the next reconciliation five seconds after the previous sweep finishes, so an unexpectedly exited monitor is recreated without a `list` or `status` call. With the Store writable, reconciliation returning normally, and the same Turn binding still current, AKK prepares one immutable `done` message/outbox entry within 30 seconds after reliable native completion evidence becomes stable. External callback transport and wake acknowledgement are outside this bound. It never launches a coding agent; new work reuses exactly one eligible agent pane that you already started in a supported terminal host.

Your task content is still processed by OpenClaw and the coding-agent or model providers you configure. Review agent permissions and keep secrets out of task prompts.

## Troubleshooting

With the global npm CLI installed, start with `agent-knock-knock doctor`. It runs bounded version probes, validates the OpenClaw config, verifies the installed/enabled/loaded plugin and bundled skill, and checks Gateway health separately. For a ClawHub-only installation, use `/akk doctor`.

| Symptom | Action |
| --- | --- |
| No eligible terminal is available | Start Codex or Claude Code inside tmux or supported Herdr as the same OS user, then run `AKK list`. |
| The npm installer or callbacks cannot find a local OpenClaw CLI | Set `openclawBin` and pass `--openclaw-bin` to `install-openclaw`. |
| Source changes do not appear | Build, reinstall from the checkout, and restart the Gateway. |
| Terminal Turn is `stalled` | Inspect `status` and the terminal; use `/akk renew only <minutes>` only when exactly one live stalled Turn needs more monitoring time. |
| Turn is `callback_failed` | Run `/akk retry-callback only` when it is the only actionable failed callback, or use its `@short-ref`. |
| A human thread switch reports `active_turn_requires_decision` | Do not redirect automatically. Ask the user to choose. For takeover, run only the complete nested `take_over_current.action` after explicit confirmation, then list again and use the fresh follow-current send. To keep the old work, restore its native thread in the TUI and refresh the list. |
| `AKK list` reports an orphaned terminal dispatch or lifecycle transition | Inspect the named pane first, then run the exact `/akk close ...` recovery command returned by `list`. It contains exactly one fresh `--expected-message-id ...` or `--expected-transition-id ...` fence; do not construct, substitute, or reuse it. AKK leaves the coding agent and terminal pane running. |
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

Maintainers can opt into the stricter native lifecycle diagnostic described
in [CONTRIBUTING.md](CONTRIBUTING.md#native-lifecycle-live-smoke-diagnostic).
It runs `A → new B → send in B → exact resume A` against explicitly selected
Codex and Claude panes, and writes redacted evidence bound to the clean checkout's
exact version and commit. It supports both managed and verified unmanaged `A`
starts, recording whether the starting Session was materialized instead of
inventing one for evidence. It never runs as part of ordinary `npm test` and
is not currently required for publishing.

## Development

```bash
npm run build
npm run typecheck
npm run test:fast
```

Use the fast tier for the inner loop, add the integration files mapped to the
subsystem you changed, and run `npm test` once before opening a pull request.
`npm test` remains the complete suite. See [Testing](docs/testing.md) for the
tier manifest, targeted integration map, profiling command, and release gates,
and [CONTRIBUTING.md](https://github.com/scotthuang/agent-knock-knock/blob/main/CONTRIBUTING.md) for the development and pull request workflow. For local OpenClaw testing, rebuild, run `node dist/src/cli.js install-openclaw`, and restart the Gateway.

### Maintainer Release

GitHub Actions runners are intentionally disabled during the current
rapid-iteration phase. From the intended clean merged `main` commit, complete
the local typecheck, full test, OpenClaw compatibility, package dry-run, and
ClawHub validation/dry-run gates; then create and push the matching `vX.Y.Z`
tag and publish npm, the GitHub Release, and ClawHub manually. Publish each
version to ClawHub once: its public index may lag the successful upload, so
verify the version-specific record instead of submitting a duplicate. The
checked-in workflows remain templates for restoring hosted release automation
later. The native lifecycle smoke remains an optional manual diagnostic rather
than a publishing prerequisite.

## Storage and Logs

Managed state now lives in the stable `~/.agent-knock-knock/store` root. Its manifest prevents an incompatible AKK writer from changing authoritative Session or Turn state. Directories use mode `0700`; state and log files use `0600`.

The manifest checks storage format and writer behavior separately. An unknown `format_version` is not read. The current writer protocol is 3, and writer protocols 1 and 2 are its supported predecessors: inspection reports either as `upgradeable`. Before the first mutation publishes a protocol-3 manifest, AKK validates the predecessor Turn records, deterministically derives and durably materializes authoritative Session records, and quarantines ambiguous Session bindings instead of routing through them. Existing Turn state and event logs remain unchanged, and the manifest's `created_at` is preserved. Any other writer-protocol mismatch remains readable for normal queries, while explicit reconciliation reports `skipped` and every mutation fails closed before terminal or Gateway side effects.

The former `~/.agent-knock-knock/conversations` directory is left untouched; AKK does not read or migrate it. Existing Codex and Claude Code tmux panes remain available through live discovery, while their old managed-turn IDs, callback associations, and legacy conversation aliases are not carried into the new Store. Compatible future upgrades continue using the stable Store rather than creating a directory per package version.

Runtime logs redact common secrets and default to 14-day retention. Configure storage and logging with `--store-dir`, `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS`; use a dedicated custom log directory.

## Security

Do not open public issues for sensitive security reports. See the [security policy](https://github.com/scotthuang/agent-knock-knock/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE).

# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Most agent orchestrators bring Codex or Claude Code into their own interface. AKK does the reverse: it brings a controller Host into the live tmux or Herdr terminal where you already work. OpenClaw has the bundled native integration; compatible third-party Hosts can use the foreground MCP/stdio Host Bridge and a declarative Profile without forking AKK. Human and agent share the same native session, so either can take over at any time without leaving the other on a forked context.

**Stay in the terminal. Stay in control. No hooks. No agent-side plugins. No YOLO.**

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

The second command proves that AKK can find the one send-ready pane, revalidate its process and pane identity, verify a scanned, non-blocked approval state, send the task, and return the result. Codex Composer visibility, stability, exactness, and parsed working activity do not veto this user-explicit Send: physical fallback sends `C-u` once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer check. Claude Code still requires an exact empty Composer. Broken AKK management state does not veto the user-explicit Send. Direct `/akk ...` commands need no OpenClaw tool-policy changes.

## See It in Action

[![AKK orchestrating a Claude Code-to-Codex handoff through tmux](https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/docs/assets/akk-tmux-handoff-demo.gif)](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/assets/akk-tmux-handoff-demo.mp4)

*OpenClaw asks Claude Code to write a file, waits for AKK to report completion, then hands the result to Codex. Both terminals remain available for direct human control. AKK keeps the agents' existing permission settings. Click the preview to watch in full quality.*

## Use Cases

**Delegate from anywhere.** Use any configured OpenClaw channel to hand work to a local coding agent while you are away from your computer. AKK reports when the agent needs attention or finishes, and you can continue from chat or the shared terminal.

**Orchestrate specialist agents.** OpenClaw can coordinate handoffs: Claude Code can plan, Codex can implement, and Claude Code can review. At any point, you can take over the live terminal, keep working yourself, then hand the same native session back to OpenClaw with its context intact.

**Connect another controller Host without an AKK fork.** A compatible Host can launch `agent-knock-knock host-bridge` as a foreground MCP/stdio child, bind its trusted current session through `environment_v1`, and inject callbacks through `command_json_v1`. The Bridge exposes the same 16 semantic tools and reuses the same Session, Turn, Watch, Store, callback, and terminal core as OpenClaw. See [Host Bridge and Host Profiles](docs/host-bridge-profiles.md) for the configuration-only prerequisites, starter Profile, validation commands, and thin-connector fallback.

**Use AKK natively from DeepSeek Harness.** DeepSeek Harness Web `0.1.1-rc.2` and `0.1.2-alpha.1` can use the first-party connector bundle. Install a published prerelease with `dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next`, or load the connector from this checkout for local validation. After one restart, every conversation receives `/akk` and the same 16 semantic tools without `/akk-bind`, copied session IDs, an AKK fork, or a standalone supervisor. The connector derives callback authority from the exact command/tool Agent and returns completion to that same live conversation. See [the DeepSeek Harness connector guide](connectors/deepseek-harness/README.md) for the five-minute quick start, exact compatibility checks, manual-approval contract, recovery steps, and prerelease boundaries.

**Use Pi as an AKK orchestrator.** Pi `0.84.4` can install the POC with `pi install npm:@scotthuang/agent-knock-knock-pi@next` and control existing Codex and Claude Code terminals through `/akk` and the same 16 semantic tools. The connector uses AKK's public HostAdapter, returns callbacks to the initiating Pi session through an authenticated local Unix socket and durable inbox, and presents approval or cancellation through Pi's native UI. It does not require a Pi fork, OpenClaw Gateway, `/akk-bind`, a repository checkout, or a standalone supervisor. See [the Pi connector guide](connectors/pi/README.md) for the five-minute npm install, complete tool workflow, callback recovery, approval behavior, and POC reliability boundary.

![Agent Knock Knock cover: OpenClaw knocking on coding agents' door](docs/assets/agent-knock-knock-cover.jpg)

## How It Works

For a managed Send, AKK connects a controller Host—OpenClaw, DeepSeek Harness, Pi, or another compatible integration—to Codex or Claude Code already running inside a supported shared terminal:

1. The controller Host selects an AKK session or terminal and sends the next user-facing request.
2. AKK verifies the bound agent pane, creates a new Turn, and writes only that request into the terminal.
3. AKK monitors the same pane for reliable approval, completion, cancellation, and failure evidence correlated to that Turn.
4. AKK reports the result, `session_id`, and `turn_id` through the initiating Host's trusted callback route.
5. A human can attach to the same tmux or Herdr terminal at any time and continue directly.

If an explicit user Send cannot enter that managed path before terminal input, AKK may deliver it once through the verified physical terminal without creating a managed Turn. It then best-effort attaches a request-bound Terminal Watch and returns a `watch_id`; that Watch supplies the callback and Status recovery path without pretending the physical Send became a managed Turn.

AKK is local-first. It has no hosted control plane or telemetry and does not change the coding agent's configured permission mode.

AKK can also observe any exact Codex or Claude Code terminal the user explicitly selects. Refreshing `/akk list` is the safest way to copy its full `terminal_id` and any advertised `watch` action, but Watch advertisement is a convenience rather than authorization: `/akk watch <exact-terminal-id>` and `watch({terminal_id})` honor that explicit read-only intent even when the current row does not advertise Watch. A coding-agent version warning, missing or incompatible task artifact, or existing AKK-managed ownership is reported but does not veto creation. AKK fails only when the exact terminal does not exist, its endpoint/process cannot be identified, neither a durable exact-task anchor nor a read-only screen-status activity path exists, or the durable Watch Store cannot be created. The returned durable `watch_id` is the only target for `/akk status <watch-id>` or `/akk unwatch <watch-id>`.

A Terminal Watch is a separate schema-v2 aggregate, not an AKK Session or Turn. It sends no terminal input and does not adopt, claim, reserve, block, interrupt, approve, or otherwise change the selected task or any managed ownership. When AKK can construct a privacy-safe Codex rollout or Claude transcript task anchor, `watch_mode="exact_task"` and `confidence="exact"` follow that task and use its durable completion/failure evidence; missing or mismatched version evidence is only a warning and does not weaken an otherwise exact anchor. If artifact, native-task, or boundary evidence cannot establish a unique exact anchor at creation, AKK records warnings and falls back to `watch_mode="terminal_activity"`, `confidence="best_effort"`. That fallback watches only the exact terminal/process activity epoch: it must observe working or approval activity and then stable idle across consecutive sweeps before emitting its completion-shaped callback. The callback explicitly means “observed activity became idle”; it is not proof that one exact task completed successfully and carries no exact-task completion text. Exact-anchor drift still invalidates that exact Watch instead of following a successor task.

An active AKK-managed Turn normally already has the better correlated monitor, so use it by preference; an explicit Watch is nevertheless allowed because it is read-only and does not replace or mutate that owner. Manual-Watch approval observations remain notification-only and must be decided by the human in the TUI. Separately, a successful `terminal_user_explicit` unmanaged fallback may automatically attach an exact request-hash-bound Watch after Send. Terminal Watch outcomes and notification outboxes survive AKK or OpenClaw restarts, with leased retry and deterministic callback idempotency.

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

The v23 model-facing action contract remains semantic-ID only. `send(session_id, request)` is **session-scoped** (`session_exact`): it creates a new `turn_id` in that exact native coding-agent context and never silently follows a different thread now visible in the pane. `send(terminal_id, request)` may be managed follow-current (`terminal_follow_current`) or the user-priority physical-terminal path (`terminal_user_explicit`), exactly as advertised by the current row. `session_id` and `terminal_id` are mutually exclusive; callers may omit both only when AKK must prove one unique send-ready pane. Human-facing slash selectors remain a discovery convenience, but structured tools never carry selectors or opaque authority values. The trusted plugin/CLI derives fresh terminal, binding, candidate, prompt, composer, and handoff fences internally. Every mutation holds the terminal lock; managed operations additionally use Store locks, while unmanaged user-priority fallback deliberately does not depend on Store health. A managed send creates a Turn and binds only the single rollout that durably accepts that exact request. The `turn_id` is not a destination for later ordinary sends; it is the exact identity used for status, approval, cancellation, renewal, callback retry, close, and callback correlation. If a Turn is `waiting_for_openclaw`, `respond(turn_id, answer)` supplies the answer inside that same Turn instead of creating another one.

v15 generalized the human-priority Codex path; v18 preserves that safety while removing opaque fences from model arguments. It covers a status-card-only Session with no rollout, a quiescent managed pane whose exact open-rollout inventory is complete but cannot identify the foreground candidate, and a supported manual `/clear` whose new logical thread is visible before its rollout materializes. The complete exact inventory domain binds the provider terminal, PID and process birth, workspace and canonical endpoint, and every open rollout's UUID, descriptor, device, inode, canonical path, and pre-submit byte offset. Native foreground resolution may be unavailable only when that independent domain is complete and exact; an incomplete, missing, stale, or changed domain fails closed. A `/clear` resume hint is advisory only. Under the terminal lock, AKK isolates the old Session, creates a separate zero-UUID provisional Session and Turn, sends only the real task, and promotes that target only after the post-submit monitor finds a unique exact request acceptance in the pinned rollout domain. The resulting native UUID may match or differ from the old Session; it is never silently merged back into the predecessor. A rollout-backed Codex row therefore advertises `terminal_follow_current` with `terminal_id`, not `session_exact`; a cached or direct `session_exact` attempt revalidates under the terminal lock, rejects before task text, and never downgrades itself to the follow-current path. Only released predecessor Turn history from a strictly earlier binding epoch is excluded from current-send authority; unresolved current-epoch state still blocks the managed path. The freshly listed semantic-ID action can work in a narrow pane without `/status`. Until promotion commits, strict `session_id` send, `respond`, managed `approve`, `cancel`, native lifecycle, callback delivery, and `native_inspect` remain unavailable. If terminal delivery or native acceptance is uncertain, AKK does not retry the input. Explicit Close is the user's management escape hatch: AKK closes the selected Turn first, sends no terminal input, leaves the coding agent and pane running, and then best-effort releases only linked AKK metadata. Missing, malformed, stale, or newer cleanup records are preserved and reported as warnings instead of vetoing Close. Refresh the list afterward; if the coding agent is still working, Watch can observe it again. v19 and v20 introduced and expanded `terminal_user_explicit`; v22 supersedes their Composer-dependent Codex behavior. Codex eligibility now depends on the exact live terminal/process and a scanned, non-blocked approval state, not Composer visibility, stability, or exactness. Physical fallback always sends one `C-u`, injects the new request, waits through the paste window, and dispatches Enter exactly once; after injection, Composer observation cannot veto Enter. Claude Code user-explicit Send, native inspection, and native lifecycle input remain exact-empty-only. The managed fast path may require exact empty before input, but after user-explicit Codex text injection it follows the same no-Composer-veto Enter rule. Broken AKK Turn, Session, deferred-transfer, transition, ledger, or Store state cannot veto the user decision. AKK tries the managed fast path where it is eligible; otherwise it delivers the physical operation once as unmanaged work. v23 captures the exact provider byte boundary before that physical mutation and, after Enter succeeds, best-effort attaches a Terminal Watch bound to the request hash and physical Send token. That Watch supplies the completion callback without claiming a managed Turn. Watch preparation or persistence failure is only a callback warning: it never vetoes, revokes, or retries the successful Send. For an omitted target, AKK durably binds the `message_id` to the first selected physical terminal before input whenever runtime durability is available, so a retry cannot move the same request to another pane. An existing or possibly existing same-ID record rejects automatic replay, and a replay reports the same persisted Watch when present. If no record exists and durability is unavailable, user priority wins: AKK proceeds with a warning, and strict cross-process replay or reselection protection is unavailable for that degraded invocation, so callers must not automatically retry its result. Once the sole mutation sequence begins, an uncertain result must not be retried automatically. `watch-status` remains the recovery path for an attached fallback Watch.

Approval remains separate from managed attribution. When `list` can prove one exact visible Codex approval prompt, it may advertise managed `approve({turn_id})` or terminal-scoped `approve({terminal_id})`; the latter remains possible when foreground rollout attribution is temporarily unavailable. The user must inspect and explicitly confirm that exact prompt. The plugin/CLI then keeps the confirmation offer private, recaptures the prompt, and revalidates the Store, terminal, process, and prompt fence under lock immediately before sending the exact key once. No token or fingerprint is transported through the model call. Terminal-scoped approval does not attribute the approval to a Turn, mutate Session identity, or create a durable approval receipt, so an uncertain transport result must not be retried blindly. It is never available to auto-approve. A changed prompt, identity, owner, or confirmation offer remains blocked.

The private approval fence remains prompt-scoped. AKK hashes the adapter-isolated, exact unredacted approval region together with the terminal/process identity, decision keys and label, prompt kind, working directory, reason/detail, and any request or policy evidence. The whole-screen digest and redacted excerpt remain diagnostic only: output outside the approval region may change without invalidating the same reviewed prompt. A change inside the region—including the command or an otherwise identically redacted secret, choices, highlighted option, prompt kind, or request identity—or a change in the bound process, working directory, or request evidence still rejects with zero approval keys. If the adapter cannot isolate one complete bounded prompt region, approval fails closed. The raw prompt region and its opaque fence are never returned to the model, persisted as public action data, or logged.

Human-friendly selectors such as `only`, `codex`, `claude`, a terminal ID, or `@short-ref` remain a slash-command discovery layer. Structured model tools use semantic IDs instead: strict continuation pre-fills `session_id`, while terminal-scoped Send pre-fills `terminal_id`. Merely observing a mismatch or an unbound rollout inventory never mutates the Store. Managed Send remains available only when AKK can prove its complete managed authority and an exact empty Composer before input. A listed `terminal_user_explicit` action has the narrower user-priority boundary instead: one exact live physical terminal/process and a scanned, non-blocked approval state. Codex applies `replace_current_composer_and_submit`; its Composer may be invisible, truncated, unstable, empty, or nonempty. Claude remains exact-empty-only. Parsed working activity and AKK internal management or persistence damage do not suppress that action. Native inspection and native lifecycle input also remain exact-empty-only. Other actions likewise expose only their semantic identities, while opaque freshness fences are derived and consumed inside the trusted plugin/CLI boundary.

An exact human switch while the old Session still has one active Turn is a decision point, not an automatic redirect. The terminal row may expose `handoff_decision` instead of a follow-current send. If the user chooses to close the old Turn, explicit Close takes priority and releases only its AKK management; it does not depend on the live native thread remaining unchanged, sends no terminal input, and does not stop the coding agent. Then list again and use only the newly advertised follow-current send. A read-only Watch may be started for the exact selected terminal whether or not the row advertises it or the old Turn remains managed. Choosing `keep_source` changes no AKK state: restore the old native thread in the Codex or Claude TUI, then refresh the list.

Native clear/new/resume operations requested through AKK are explicit lifecycle actions, separate from ordinary Turn creation. A successful new/clear creates a new native thread and AKK Session; resume activates the exact historical native thread and its corresponding Session. Each successful lifecycle transition creates no Turn. A human may also run native `/clear`, `/new`, `/resume`, or the equivalent directly in the shared terminal. AKK does not forbid that takeover: the next exact, fresh terminal-scoped follow-current send can absorb the human-driven transition when it is safe, while a `session_id` send deliberately remains pinned to its old context. AKK serializes either transition, verifies the resulting native identity, and advances the terminal binding generation so work and callbacks from the previous context cannot cross the boundary. Exact AKK-driven lifecycle profiles are regression-tested for Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1/0.150.1 and Claude Code 2.1.218/2.1.226/2.1.237/2.1.251. They are verification records, not an allowlist: another complete `x.y.z` version keeps Watch, native inspection, candidate discovery, new, and resume available through the generic runtime protocol, with a compatibility warning. Runtime structure and postconditions still decide success; a possibly submitted but unproven operation is reported as uncertain and is never retried automatically.

AKK status and native status inspection are different operations. `agent_knock_knock_status` (and `/akk status`) reads AKK Turn state plus a bounded current terminal screen; it does not execute the coding agent's `/status`. When an idle terminal row advertises `native_inspect`, `agent_knock_knock_native_inspect({terminal_id, inspection:"status"})` can execute only that closed inspection. AKK derives and revalidates the fresh binding fence internally. Regression-tested profiles are Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1/0.150.1 and Claude Code 2.1.218/2.1.226/2.1.237/2.1.251; other complete `x.y.z` versions remain callable with a compatibility warning and use the same bounded runtime validation. Claude's adapter parses a newly opened Status panel, dismisses that exact panel once, and proves the same pane returned to an idle empty composer. The action creates no Session, Turn, receipt, monitor, or callback. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and arbitrary slash strings remain unavailable. A structurally incompatible native status result fails or becomes uncertain after the one permitted input; it is not retried automatically. In particular, bare Codex `/usage` opens an interactive menu whose later Enter can select an account-side usage-limit reset; do not automate it as a read-only inspection.

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

Claude tmux support requires no hooks and does not modify Claude Code settings. Hook-free completion monitoring is verified on Claude Code `2.1.198`, `2.1.218`, `2.1.226`, `2.1.237`, and `2.1.251`; newer versions remain eligible when their interactive transcripts preserve the required identity and completion structure. Hookless auto-approval is deliberately narrower: approval evidence currently requires Claude Code `2.1.x` at `2.1.198` or later, and other versions fall back to manual handling.

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

AKK discovers live Codex and Claude Code panes across workspaces. Managed Send requires a verified idle prompt; an advertised `terminal_user_explicit` Send may also steer a working pane when its exact terminal/process identity and approval boundary remain valid. Codex Composer observation is advisory for this user-explicit path, while Claude still requires exact empty. AKK never starts a coding agent for you.

If exactly one send-ready coding-agent pane exists across all workspaces, send a task directly:

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
/akk watch <exact-terminal-id>
/akk unwatch <watch-id>
/akk threads <exact-terminal-id>
/akk new-thread <exact-terminal-id>
/akk clear-thread <exact-terminal-id>
/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id]
/akk status [only|latest|codex|claude|@short-ref|terminal-watch-id]
/akk respond <turn-selector>: <answer>
/akk cancel <turn-selector>
```

`/akk list` performs a controlled reconciliation across managed turns, and managed `/akk status` limits reconciliation to the selected turn. This can close records whose idle retention has elapsed and restore eligible missing monitors, but it does not send terminal input or retry managed-Turn callback delivery. A `watch_id` status reads that independent Watch record. The running OpenClaw supervisor coordinates two separate reconciliation passes every five seconds and at startup: one restores eligible `waiting_for_agent` Turn monitors, while the other observes active Terminal Watches and retries their durable callback outboxes. Each pass has its own error boundary, so one failure does not starve the other. Standalone shell queries are read-only unless their command explicitly reconciles, and resolving a selector never changes turn state.

Selectors fail closed: `only` works only with one actionable target, `latest` requires a unique newest target, and `codex` or `claude` must identify exactly one eligible pane. These names and `@short-ref` are human-facing slash-command resolution inputs. The v23 structured model contract does not expose a `selector`: JSON actions carry an authoritative `session_id`, `terminal_id`, `turn_id`, `watch_id`, or other semantic entity ID. For ordinary send, exactly one of `session_id` and `terminal_id` may be supplied, or both may be omitted to require one unique send-ready pane. Approval likewise uses only `turn_id` or `terminal_id` after explicit confirmation. Before every terminal operation, AKK derives fresh opaque authority internally and revalidates the expected agent PID and provider-owned terminal identity. `terminal_user_explicit` additionally requires a scanned, non-blocked approval state. Codex Composer visibility, stability, exactness, and parsed working activity are not eligibility requirements; Claude still requires an exact empty Composer.

To ask AKK itself to change native context, first copy the full `terminal_id` from `/akk list`; lifecycle commands do not accept an ordinary-send `@short-ref` or loose agent selector. `/akk threads <exact-terminal-id>` lists exact, same-workspace candidates with a deterministic number, a collision-safe display-only `@short-id`, and the complete UUID. `/akk resume-thread <exact-terminal-id>` without a selection shows that list. A complete UUID remains compatible. A number or short ID resolves only against the latest list displayed in the same OpenClaw conversation incarnation; both expire after five minutes and fail after terminal, process, workspace, binding, candidate-set, or relevant action changes. AKK resolves that human navigation to the complete UUID and derives fresh private evidence under lock. `previous` (or `刚才那个`) is advertised only when the current Session's latest committed lifecycle transition identifies exactly one currently verified resumable source; it never guesses from title, recency, or static lineage. If `previous` is present, use only its exact prefilled semantic-ID action for a natural-language “刚才那个” request. Structured lifecycle mutations are `new_thread({terminal_id})` and `resume_thread({terminal_id,native_thread_id})`. AKK does not poll bindings or adopt observed switches in the background: a human-driven switch is adopted only as part of an explicit, fresh terminal-scoped send. If a recorded owner process exits, the next lifecycle listing can classify that sole historical binding as resumable, and the resume mutation compare-and-swap detaches it before touching the terminal. Stale, expired, unsupported, busy, ambiguous, active-elsewhere, or unverifiable transitions fail closed. Do not ask AKK to send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, or `/btw`, Claude `/branch`, or any other first-line native slash command as an ordinary task or answer; use an advertised AKK action, express the request in natural language, or enter an unsupported native command manually in the terminal UI.

The number and short-ID resume forms refer only to that displayed snapshot; neither is a durable identity or model authority.

To request a native Codex status card or Claude Status panel, first run `agent_knock_knock_list` and use only that terminal row's advertised `native_inspect({terminal_id,inspection:"status"})` action. The structured tool schema is closed to those two semantic fields; callers cannot provide `/status`, another slash command, or an authority token. AKK serializes the inspection with terminal mutations, derives and revalidates its private binding fence and exact terminal identity, and returns only after it proves one fresh bounded status result and an idle postcondition. Codex status probes additionally require an exact viewport of at least 80 columns to preserve the full Session UUID, cross the versioned paste-settle boundary, and dispatch Enter exactly once. An initially narrow or unknown viewport fails before text input with a widen/zoom diagnostic; post-injection viewport or composer drift fails closed before Enter and leaves the draft for manual inspection. Codex `/status` and that viewport requirement apply only to operations that must prove the UUID before terminal input. An otherwise eligible terminal-scoped ordinary task can send once and bind from exact native acceptance afterward, so it does not run `/status` or fail merely because the pane is narrow. For Claude, the inspection safely dismisses the exact modal once. It never turns ordinary `send` or `respond` into a slash-command escape hatch.

The current OpenClaw surface registers 16 tools, and the top-level v23 `action_contracts` documents Terminal Watch alongside closed native inspection, user-priority current-pane Send/approval, lifecycle, and Turn actions. Every model-facing action carries semantic IDs only; opaque freshness and compare-and-swap fences stay inside the trusted plugin/CLI boundary. `available_actions` remains the authority for ordinary current actions. Read-only Watch is the deliberate exception: once the user supplies one exact listed `terminal_id`, missing Watch advertisement, agent-version or artifact uncertainty, and managed ownership are warnings rather than authorization vetoes. A listed `terminal_user_explicit` Send prioritizes the user's exact live physical terminal/process over broken AKK internal state. Codex physical fallback replaces the current Composer with the new request and submits once without a post-text Composer veto; Claude remains empty-only. AKK attempts managed delivery where eligible, then may deliver unmanaged and attach an exact Terminal Watch callback without creating a managed Turn. Watch failure is reported without changing delivery. Explicit Close is always available for a selected managed Turn after user confirmation, including deferred-transfer and handoff conflicts; it releases AKK management without terminal input or stopping the coding agent. A terminal row may also expose a nested `blocking_turns[].recovery_action` for the same user-owned Close. Invoke the advertised semantic-ID action, then refresh the list before doing anything else.

For natural-language tool use, `agent_knock_knock_list` is terminal-first. Each live pane appears exactly once in `terminals[]`; `process_state` reports whether its coding-agent process is alive and `activity_state` reports the parsed screen state. `managed.session_id` identifies the continuing AKK session, `managed.current_turn` is its optional active Turn, and `managed.recent_turn` is retained history; retained Turns do not occupy the terminal. A human-driven native-thread mismatch remains honestly classified as `management_state="conflict"`; its `handoff_state` is `external_handoff_adoptable` only when the row advertises the fenced follow-current `send`, otherwise it is `external_handoff_blocked`. `management_state="unavailable"` means only that AKK's management projection could not be read; the separately observed live terminal facts and any advertised `terminal_user_explicit` Send remain authoritative. Listing never performs the adoption. Pass `all=true` to include older entries in `managed.history`. By default, `unavailable_managed_turns[]` contains attention-needed records whose pane cannot be presented as a live terminal; `all=true` also includes retained unavailable history.

Except for read-only Watch, use only an `available_actions` entry returned in the current list, begin with its prefilled semantic IDs, and supply every `missing_required` field. A user-explicit Watch may instead pass one exact listed `terminal_id` directly; the absence of `available_actions.watch` does not veto observation. The only other action sources are a terminal row's nested `handoff_decision.choices.take_over_current.action` and an exact `blocking_turns[].recovery_action`; both require explicit user confirmation. When advertised, a managed Session's strict send uses `send({session_id,request})` and creates a new Turn only in that Session's native context. Terminal-scoped Send uses `send({terminal_id,request})`. A `terminal_user_explicit` action is the user-priority path: healthy AKK state still takes the managed fast path where its exact-empty pre-input requirements hold, while Codex physical fallback always replaces the current Composer with the request and submits it once without a post-text Composer veto. Claude can fall back only from an exact empty Composer. Unmanaged delivery creates no managed callback Turn; after successful Enter, AKK best-effort attaches an exact Terminal Watch callback. Attachment failure is a warning and never changes the Send result. Structured Send never exposes a selector, draft text, or composer authority. `respond` and managed controls use `turn_id`; terminal-scoped approval uses `terminal_id` only after explicit confirmation. Native inspection uses `{terminal_id,inspection:"status"}`. Other raw controls may be used only through the exact action their row advertises. `timeoutSeconds` is unsupported, and monitoring limits should be omitted unless the user explicitly asks to change them. AKK derives fresh opaque fences and revalidates availability under lock before every side effect.

On first attach, the target terminal must be explicitly named by the user; AKK never guesses which already-running pane should receive a task.

The top-level v23 action contracts include `watch` and `unwatch` as well as `send`, manual `approve`, `native_inspect`, `list_resumable_threads`, `new_thread`, `resume_thread`, and conflict-only `reconcile_binding`. Their model-facing mutation shapes are deliberately small: `watch({terminal_id})`; `send({session_id|terminal_id,request})` with the targets mutually exclusive; managed `approve({turn_id})` or terminal-scoped `approve({terminal_id})`; `native_inspect({terminal_id,inspection})`; `new_thread({terminal_id})`; `resume_thread({terminal_id,native_thread_id})`; and `reconcile_binding({terminal_id,conflicting_session_id})`. Watch status exposes `watch_mode` and `confidence`: exact provider evidence yields `exact_task`/`exact`, while the terminal-activity fallback yields `terminal_activity`/`best_effort` plus creation warnings. The listed Send scope distinguishes managed delivery from `terminal_user_explicit`; the latter is gated by exact terminal/process identity and scanned, non-blocked approval state, not AKK management health or Codex Composer observation. An unmanaged fallback creates no managed Turn but can return `callback_mode="terminal_watch"` and a durable `watch_id`. Approval, handoff takeover, and reconciliation require explicit user confirmation, but none transports a token, revision, binding ID/generation, candidate or composer fence, handoff-only live-native-UUID fence, or approval fingerprint through the model. `native_thread_id` remains the intentional semantic identity for resume. `watch` returns a `watch_id`; Watch status and `unwatch` use only that ID. Human-facing resume numbers and short IDs remain conversation-scoped navigation aids that AKK resolves to the complete native thread ID before the structured action. Orphan close retains `expected_message_id` or `expected_transition_id` because those are entity identities, not opaque authority tokens. The plugin/CLI derives and revalidates all freshness fences privately under the canonical locks. Store format remains 1 and writer protocol remains 6.

Workspace is not a routing boundary. AKK can list, inspect, and control verified panes across projects; when more than one target matches, choose one listed `terminal_id` for a structured tool or one listed selector for a slash command.

If no eligible pane exists, AKK stops with setup guidance. If a send is ambiguous, run `/akk list` and retry with the returned `@short-ref`.

## Configuration

AKK works without project-specific plugin configuration. It reads these optional settings from `plugins.entries.agent-knock-knock.config`:

| Option | Default | Purpose |
| --- | --- | --- |
| `storeDir` | `~/.agent-knock-knock/store` | Stable Store root for the compatibility manifest, authoritative managed Sessions and Turns, plus independent Terminal Watch records. |
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
- When no trusted rule matches, the callback takes the manual path. The callback itself cannot authorize approval: the model must first call structured `agent_knock_knock_status({turn_id})` in the current OpenClaw conversation, present that current request, and obtain the user's explicit confirmation. Only then may it invoke the advertised managed `approve({turn_id})` action.
- AKK privately recaptures the confirmed prompt and revalidates its fingerprint, process, pane, and Turn immediately before sending one Enter; no fingerprint or token is copied through model arguments.

For Codex, a currently visible one-time approval may also be handled through the terminal row's `approve({terminal_id})` action when managed foreground UUID attribution is unavailable. On an unmanaged raw-terminal row, this action is prefilled with its exact `terminal_id`; never construct or guess that target. The user must first inspect the current AKK status and explicitly confirm that exact prompt. AKK retains the confirmation offer and prompt fence privately, recaptures both under lock, and sends the detected key once only if they still match. The action leaves Session/Turn identity unchanged and is never an auto-approval fallback.

Unknown, stale, changed, process-drifted, ownership-conflicted, or unmanaged dialogs without an advertised action fail closed and must be resolved in the terminal.

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

Use only the fast tier during development, debugging, refactoring, review, and
local installation or verification. Do not run integration, affected, full, or
release tiers for those workflows. Run the full/release gate only immediately
before an actual npm or ClawHub publication. See [Testing](docs/testing.md) for
the tier manifest, coverage map, profiling command, and release gates, and
[CONTRIBUTING.md](https://github.com/scotthuang/agent-knock-knock/blob/main/CONTRIBUTING.md) for the development and pull request workflow. For local OpenClaw testing, rebuild and run `node dist/src/cli.js install-openclaw`; the installer performs its own single Gateway restart when needed, so do not restart it a second time. A local install is not a release and still uses only `npm run test:fast`.

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

The manifest checks storage format and writer behavior separately. An unknown `format_version` is not read. The current writer protocol is 6, and writer protocols 1 through 5 are its supported predecessors: inspection reports them as `upgradeable`. Upgrading protocol 1 or 2 validates predecessor Turn records, deterministically derives and durably materializes authoritative Session records, and quarantines ambiguous Session bindings before atomically publishing protocol 6. Protocols 3, 4, and 5 already have Session authority, so their upgrade is an atomic manifest-only writer fence with no data migration. Protocol 6 prevents an older writer from silently rejecting or damaging v2 Terminal Watch records. Existing Turn state and event logs remain unchanged, and the manifest's `created_at` is preserved. Any other writer-protocol mismatch remains readable for normal queries, while explicit reconciliation reports `skipped` and every mutation fails closed before terminal or Gateway side effects.

The former `~/.agent-knock-knock/conversations` directory is left untouched; AKK does not read or migrate it. Existing Codex and Claude Code tmux panes remain available through live discovery, while their old managed-turn IDs, callback associations, and legacy conversation aliases are not carried into the new Store. Compatible future upgrades continue using the stable Store rather than creating a directory per package version.

Runtime logs redact common secrets and default to 14-day retention. Configure storage and logging with `--store-dir`, `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS`; use a dedicated custom log directory.

## Security

Do not open public issues for sensitive security reports. See the [security policy](https://github.com/scotthuang/agent-knock-knock/blob/main/SECURITY.md).

## License

MIT. See [LICENSE](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE).

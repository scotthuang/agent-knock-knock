# Agent Knock Knock in 5 Minutes

This is the canonical ClawHub setup: OpenClaw and a human share one live Codex or Claude Code terminal without changing the coding agent's permission mode.

## Before you start

You need:

- A Node.js version supported by OpenClaw; Node.js 24 LTS is recommended
- OpenClaw `2026.6.5` or newer
- tmux
- An installed and authenticated `codex` or `claude` CLI
- OpenClaw, tmux, and the coding agent running as the same OS user

AKK reuses a coding agent that you start in tmux. It never installs, authenticates, or launches Codex or Claude Code for you.

## 1. Install AKK

Install the ClawHub package and restart the Gateway:

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

The ClawHub package includes the OpenClaw plugin, bundled AKK skill, and its package-local relay CLI. Ordinary installation does not require a project workspace setting.

## 2. Start the shared terminal

```bash
cd /absolute/path/to/project
tmux new-session -s akk-work -c "$(pwd -P)" codex
```

Use `claude` instead of `codex` to share a Claude Code terminal. Wait until the coding agent is authenticated and showing its idle prompt. Detach from tmux with `Ctrl-b`, followed by `d`.

AKK discovers supported Codex and Claude Code panes across workspaces. Before acting, it revalidates the expected agent PID and tmux pane identity, then confirms that the process and pane working directories still match. Managed Send requires a verified idle prompt; an advertised user-explicit physical Send may steer a working Codex pane when its scanned, non-blocked approval boundary remains valid even if the Composer cannot be observed. Claude still requires exact empty.

## 3. Run doctor

From any configured OpenClaw channel:

```text
/akk doctor
```

Success starts with:

```text
AKK doctor: ready
```

Doctor verifies the installed plugin and skill, Gateway health, tmux, and at least one supported coding-agent CLI. It does not make a credentialed model call or require a live pane.

## 4. Send the first task

```text
/akk inspect this repository and summarize it
```

The bare task works when exactly one send-ready coding-agent pane exists across all workspaces. Send-ready means an exact live terminal/process and a scanned, non-blocked approval state. Parsed working activity and Codex Composer visibility, stability, or exactness do not veto this user-priority path. Codex physical fallback sends `C-u` once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto. Claude Code still requires an exactly empty Composer. Broken AKK management state does not veto this user-explicit Send. If more than one pane is eligible, AKK stops instead of guessing: run `/akk list`, then use `/akk <selector>: <message>`, for example:

```text
/akk @a1b2c3d4: inspect this repository and summarize it
```

Success returns a managed turn and, when the work finishes, its result. The same tmux pane remains available for direct human control; reattach with `tmux attach -t akk-work`.

`/akk list` keeps that physical pane as the primary resource: it appears once in `terminals[]` with live `process_state` and `activity_state`. Its managed context follows terminal → native coding-agent session → AKK `session_id` → Turns. AKK places the active Turn under `managed.current_turn`, or the newest retained Turn under `managed.recent_turn`; retained Turns do not occupy or hide the pane.

For another request, refresh `/akk list` and use only that terminal row's listed v23 `send` action. A `session_exact` action carries `session_id`; `terminal_follow_current` and user-priority `terminal_user_explicit` actions carry `terminal_id`. Add only the new request text. The two target fields are mutually exclusive, and a structured model call never carries a selector, draft text, composer digest, or opaque token. AKK derives and revalidates its freshness fences internally. Managed delivery may require exact empty before input and creates a new `turn_id`; native inspection and lifecycle input remain exact-empty-only. Codex `terminal_user_explicit` advertises `replace_current_composer_and_submit`. If the managed path injects user-explicit Codex text, or if physical fallback runs, Composer observation cannot veto the one Enter after injection. Claude user-explicit delivery still requires empty. The physical fallback creates no managed callback Turn; after Enter, AKK best-effort attaches an exact Terminal Watch callback and returns its `watch_id`. Attachment failure is a warning and never changes delivery. Once mutation begins, an uncertain result must not be retried automatically; use Watch status for recovery. A completed Turn is history, not the destination of the next send. Human-friendly selectors such as `codex`, `only`, or `@a1b2c3d4` remain slash-command discovery conveniences; they are not structured action authority.

If the coding agent asks a question and the active Turn becomes `waiting_for_openclaw`, use the listed `respond` action with its prefilled `turn_id`, or the equivalent form:

```text
/akk respond <turn-selector>: <answer>
```

This answer stays in the same Turn. Managed status, approval, cancellation, renewal, callback retry, and close also use the exact `turn_id`. Other structured actions use only the semantic IDs advertised on their row; never construct a target or authority field.

Starting a new native context, clearing it, or resuming an older native thread is an explicit lifecycle operation, not an ordinary send. Copy the full `terminal_id` from `/akk list`, then use:

```text
/akk threads <exact-terminal-id>
/akk new-thread <exact-terminal-id>
/akk clear-thread <exact-terminal-id>
/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id]
```

Omitting the resume selection lists exact verified candidates. You may use the complete UUID, or the deterministic number or collision-safe `@short-id` from that same displayed snapshot. Numbers and short IDs are valid only for the latest list shown in the same OpenClaw conversation incarnation and expire after five minutes or any relevant terminal, process, workspace, binding, or candidate change. `previous` / `刚才那个` works only when the list advertises a single verified source from the current Session's latest committed lifecycle transition; AKK never treats “previous” as “newest”. AKK resolves these display selectors privately to the complete UUID; the structured mutation is only `resume_thread({terminal_id,native_thread_id})`, while binding and candidate fences stay inside the plugin/CLI. A successful switch creates or activates an AKK Session but creates no Turn, so send the next request separately. There is no background binding poll: after an old coding-agent process exits, the next lifecycle listing can expose its sole historical Session as resumable, and resume safely detaches that stale binding before terminal input. Unsupported, busy, ambiguous, stale, expired, active-elsewhere, or unverifiable transitions stop without falling back to raw `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, or `/btw`, or Claude `/branch` text.

AKK Turn status and the coding agent's native status are separate. `/akk status` and `agent_knock_knock_status` inspect AKK-managed state and a bounded current screen; they never type `/status`. For native status, start from `/akk list` and use only an advertised `agent_knock_knock_native_inspect({terminal_id,inspection:"status"})` action. AKK derives and revalidates the binding fence internally. Regression-tested profiles are Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1/0.150.1/0.151.0 and Claude Code 2.1.218/2.1.226/2.1.237/2.1.251. Other complete `x.y.z` versions remain callable through the generic runtime protocol and display a compatibility warning; a real UI/schema incompatibility fails at runtime and is never retried automatically. Claude's modal Status panel is parsed and dismissed before the action proves the original idle composer. The action creates no Session, Turn, receipt, monitor, or callback. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and arbitrary slash commands remain unavailable. Bare Codex `/usage` is not read-only automation: it opens a menu whose later Enter can select an account-side usage-limit reset.

## 5. Watch an exact terminal without changing it

You can start a task yourself by typing it directly in the Codex or Claude Code TUI, then let OpenClaw observe that terminal without handing the task to AKK. You can also explicitly add a read-only Watch alongside an existing managed Turn; it does not replace or change that Turn. Send a fresh:

```text
/akk list
```

Copy the row's complete `terminal_id`. An advertised `available_actions.watch` is the recommended convenience, but its absence is not a veto when the user explicitly selected the exact terminal. For either the structured tool or slash form, pass only that ID:

```text
/akk watch <exact-terminal-id>
```

Watch is read-only and user-intent-first. Agent-version or artifact uncertainty, missing binding metadata, existing AKK-managed ownership, and missing action advertisement produce warnings rather than blocking creation. AKK fails only when the exact terminal is absent, its endpoint/process cannot be identified, neither an exact durable task anchor nor a read-only screen-status path exists, or its durable Store record cannot be created. Prefer an existing managed monitor when its exact Turn attribution is what you need, but Watch can coexist without adopting or mutating it. A successful user-explicit unmanaged fallback may separately attach an automatic exact-request Watch after AKK sends.

The result contains a durable `watch_id`. Use that ID—not a `session_id`, `turn_id`, terminal selector, or short reference—to inspect or stop observation:

```text
/akk status <watch-id>
/akk unwatch <watch-id>
```

Terminal Watch schema v2 is independent of managed Sessions and Turns. The Watch sends no terminal input and does not adopt, claim, reserve, block, interrupt, approve, or otherwise change the task; `unwatch` only marks the Watch cancelled. A manual-Watch approval event is notification-only: inspect and approve or deny it yourself in the live TUI. Automatic fallback Watch currently reports completion/failure/recovery outcomes only and never invokes an approval action or participates in `autoApprove`.

AKK prefers an exact provider task anchor. When it can bind the Codex rollout or Claude transcript task, status reports `watch_mode="exact_task"`, `confidence="exact"`; durable task completion wins, and later endpoint/process/thread/file/boundary drift invalidates that exact Watch instead of following a successor. If no unique usable task anchor can be built at creation, AKK records the diagnostics and falls back to `watch_mode="terminal_activity"`, `confidence="best_effort"`. That mode watches only the selected terminal/process epoch, first observes `working` or `awaiting_approval`, then requires stable `idle` across consecutive sweeps. Its callback means only “observed terminal activity became idle”—not that one exact task completed or succeeded—and includes no exact-task completion text. Starting from idle or unknown does not immediately complete. Both modes keep durable outcome and callback-outbox state so supervision can resume and retry idempotent delivery after AKK, OpenClaw, or Gateway restarts.

## Optional: Enable natural-language routing

Direct `/akk ...` commands work without changing the OpenClaw tool policy. To let OpenClaw decide to use AKK from a natural-language request, grant the optional `agent-knock-knock` tools in the applicable policy.

If you use the default `coding` profile and do not already have `tools.allow`:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["agent-knock-knock"]
  }
}
```

If a restrictive `tools.allow` list already exists at that scope, add `"agent-knock-knock"` to that list instead. Do not configure `allow` and `alsoAllow` at the same scope.

Restart the Gateway after changing the tool policy.

## Alternative: Install from npm

Use this route only when you also want the standalone `agent-knock-knock` shell command:

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --verify
```

Do not run `install-openclaw` after a ClawHub install. The two commands are alternative installation paths.

## Permissions and monitoring

AKK keeps the coding agent's own permission settings. Trusted, exact `autoApprove` rules may approve a supported managed-Turn prompt; each rule can authorize multiple canonical roots through `autoApprove.rules[].workspaces`. Those entries are the only workspace boundary for automatic approval and do not limit pane discovery or manual control. Terminal Watch approval notifications are never eligible for automatic approval. Everything else remains manual. If monitoring stalls while the same managed Turn is still live, inspect `/akk status only` and use `/akk renew only <minutes>` to resume monitoring without sending terminal input.

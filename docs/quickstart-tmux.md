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

AKK discovers supported Codex and Claude Code panes across workspaces. Before acting, it revalidates the expected agent PID and tmux pane identity, then confirms that the process and pane working directories still match; sending new work also requires a verified idle prompt.

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

The bare task works when exactly one send-ready coding-agent pane exists across all workspaces. Send-ready means an exact live terminal/process, a verified non-blocked approval state, and an exactly empty composer; `activity_state` and broken AKK management state do not veto this user-explicit Send. If more than one pane is eligible, AKK stops instead of guessing: run `/akk list`, then use `/akk <selector>: <message>`, for example:

```text
/akk @a1b2c3d4: inspect this repository and summarize it
```

Success returns a managed turn and, when the work finishes, its result. The same tmux pane remains available for direct human control; reattach with `tmux attach -t akk-work`.

`/akk list` keeps that physical pane as the primary resource: it appears once in `terminals[]` with live `process_state` and `activity_state`. Its managed context follows terminal → native coding-agent session → AKK `session_id` → Turns. AKK places the active Turn under `managed.current_turn`, or the newest retained Turn under `managed.recent_turn`; retained Turns do not occupy or hide the pane.

For another request, refresh `/akk list` and use only that terminal row's listed v19 `send` action. A `session_exact` action carries `session_id`; `terminal_follow_current` and user-priority `terminal_user_explicit` actions carry `terminal_id`. Add only the new request text. The two target fields are mutually exclusive, and a structured model call never carries a selector or opaque token. AKK derives and revalidates its freshness fences internally. Managed delivery creates a new `turn_id`. If broken AKK state prevents managed delivery before input, `terminal_user_explicit` sends once without a callback Turn, then releases stale management best-effort; refresh the list and use Watch. A completed Turn is history, not the destination of the next send. Human-friendly selectors such as `codex`, `only`, or `@a1b2c3d4` remain slash-command discovery conveniences; they are not structured action authority.

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

AKK Turn status and the coding agent's native status are separate. `/akk status` and `agent_knock_knock_status` inspect AKK-managed state and a bounded current screen; they never type `/status`. For native status, start from `/akk list` and use only an advertised `agent_knock_knock_native_inspect({terminal_id,inspection:"status"})` action. AKK derives and revalidates the binding fence internally. Supported profiles are Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1 and Claude Code 2.1.218/2.1.226/2.1.237. Claude's modal Status panel is parsed and dismissed before the action proves the original idle composer. The action creates no Session, Turn, receipt, monitor, or callback. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and arbitrary slash commands remain unavailable. Bare Codex `/usage` is not read-only automation: it opens a menu whose later Enter can select an account-side usage-limit reset.

## 5. Watch work you started in the TUI

You can start a task yourself by typing it directly in the Codex or Claude Code TUI, then let OpenClaw observe it without handing the task to AKK. While that exact task is actively working or awaiting approval, send a fresh:

```text
/akk list
```

Proceed only if that terminal row advertises `available_actions.watch`. For either the structured tool or slash form, pass only that row's exact terminal ID. Watch resolves the current internal binding authority, then scans again while holding the terminal lock before creating the Watch:

```text
/akk watch <exact-terminal-id>
```

Terminal Watch is only for human-started external work. If the terminal already has an active AKK-managed Turn, list and status do not offer Watch and a direct Watch attempt is rejected; use that Turn's existing monitor, status, and callback path instead.

The result contains a durable `watch_id`. Use that ID—not a `session_id`, `turn_id`, terminal selector, or short reference—to inspect or stop observation:

```text
/akk status <watch-id>
/akk unwatch <watch-id>
```

Terminal Watch schema v1 is independent of managed Sessions and Turns. It sends no terminal input and does not adopt, claim, reserve, or block the task; `unwatch` only marks the Watch cancelled and does not interrupt the TUI. An approval event is notification-only: inspect and approve or deny it yourself in the live TUI. Terminal Watch never invokes an approval action or participates in `autoApprove`.

The Watch remains pinned to the exact terminal endpoint, process incarnation, native task, and privacy-safe Codex rollout or Claude transcript boundary captured at creation. An exact durable completion already written to that anchor wins; otherwise a replaced process, switched native thread, moved/replaced/truncated evidence file, changed boundary, or ambiguous successor invalidates the Watch instead of following current work. Its schema-v1 record, outcome, and notification outbox are durable, so startup and periodic supervision can resume observation and retry an idempotent callback after AKK, OpenClaw, or the Gateway restarts.

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

# agent-knock-knock

Agent Knock Knock lets OpenClaw delegate work to local coding agents such as Codex, Claude Code, and Cursor, keep those delegations alive as reusable tasks, and route follow-up messages or results back through OpenClaw.

The name is literal: OpenClaw knocks on the door of another coding agent, hands it a task, waits for the callback, and can knock again later with follow-up instructions. AKK provides the persistent task layer that makes that workflow practical across chat channels.

## Why This Exists

OpenClaw already has built-in session spawning, but persistent ACP sessions can depend on thread-bound channels such as Discord or Telegram. That model works well when the external channel can attach replies to a stable thread.

Channels such as WeChat and many direct-message surfaces do not provide that same thread primitive. Without an external thread, OpenClaw needs another durable place to remember which coding agents are working, which task each agent owns, and where follow-up messages should go.

Agent Knock Knock fills that gap. It keeps local task state outside the chat channel, uses ACPX / ACP to talk to coding agents, and gives OpenClaw tools to delegate, list, inspect, continue, cancel, and close work without relying on any external channel feature.

## What It Provides

- ACPX-backed delegation to Codex, Claude Code, and Cursor
- Reusable task sessions for follow-up messages after the first result
- Task listing, status inspection, follow-up send, cooperative cancellation, and local close
- Structured callbacks back into OpenClaw through the plugin Gateway method
- Conversation state stored in the user's home directory for recovery across OpenClaw turns
- Runtime diagnostics logs with local timestamps, redaction, and retention cleanup
- A short `AKK` routing convention for chat and `/akk` command surfaces

See [ROADMAP.md](ROADMAP.md) for planned reliability work and future orchestration features.

## Project Status

Agent Knock Knock is an early public project. The core local OpenClaw delegation flow is usable, but the OpenClaw plugin and skill are still installed from a local checkout rather than a packaged plugin registry.

## Architecture

OpenClaw is the top-level orchestrator. Agent Knock Knock runs as the OpenClaw plugin bridge, uses ACPX / ACP to communicate with local coding agents, and keeps enough local task state for OpenClaw to manage many concurrent coding-agent sessions.

![Agent Knock Knock architecture](docs/assets/architecture.png)

## Prerequisites

- Node.js 20+
- OpenClaw installed and running
- ACPX installed globally:

  ```bash
  npm install -g acpx
  acpx --version
  ```

- At least one local coding agent:
  - Codex, if you want Codex delegation
  - Claude Code, if you want Claude delegation
  - Cursor, if you want Cursor delegation

Agent Knock Knock does not manage Codex, Claude Code, or Cursor authentication. Make sure the agent you want to use is already installed and logged in before delegating tasks.

## Install

After cloning this repository, you can ask OpenClaw to install it for you:

```text
Install this Agent Knock Knock project into my local OpenClaw:
1. Make sure Node.js 20+, OpenClaw, and at least one local coding agent such as Codex, Claude Code, or Cursor are installed.
2. Install ACPX globally if it is missing: npm install -g acpx.
3. Run npm install.
4. Run npm run build.
5. Link and enable the OpenClaw plugin from this repository.
6. Install the Agent Knock Knock skill template into ~/.openclaw/skills/agent-knock-knock/SKILL.md.
7. Restart the OpenClaw Gateway.
```

Manual installation:

Install the plugin into OpenClaw during local development:

```bash
npm install
npm run build
openclaw plugins install --link .
openclaw plugins enable agent-knock-knock
```

Install the OpenClaw skill template so OpenClaw learns when to route chat requests to AKK:

```bash
mkdir -p ~/.openclaw/skills/agent-knock-knock
cp templates/openclaw-skills/agent-knock-knock/SKILL.md ~/.openclaw/skills/agent-knock-knock/SKILL.md
```

Apply local project updates to OpenClaw:

```bash
npm install
npm run build
openclaw plugins install --link .
openclaw plugins enable agent-knock-knock
openclaw gateway restart
```

Run this after pulling new code or editing TypeScript/plugin files. The OpenClaw plugin loads compiled files from `dist/`, so source changes do not take effect until `npm run build` has run and the Gateway has reloaded the linked plugin. If the skill template changes, copy `templates/openclaw-skills/agent-knock-knock/SKILL.md` to `~/.openclaw/skills/agent-knock-knock/SKILL.md` again.

## OpenClaw Plugin

The native OpenClaw plugin registers tools that let OpenClaw delegate implementation work to Codex, Claude Code, or Cursor, list open sessions, send follow-up messages, inspect status, request cooperative cancellation, and close sessions without exposing raw terminal output as tool results.

Natural-language routing is designed around the short name `AKK`; lowercase `akk` should be treated the same way. When a user says `AKK` without naming an agent, OpenClaw should omit the agent parameter and let the plugin use `defaultAgent`. If `defaultAgent` is not configured, AKK falls back to Codex. Explicit requests such as `AKK Claude`, `AKK Cursor`, or `AKK Codex` override the default.

Configure the default coding agent in the plugin config:

```json5
{
  plugins: {
    entries: {
      "agent-knock-knock": {
        config: {
          defaultAgent: "codex" // "codex", "claude", or "cursor"
        }
      }
    }
  }
}
```

Useful chat-style prompts:

```text
akk: fix the failing tests in this project
AKK Codex: review the current branch and propose a small fix
AKK Claude: review the latest commit
AKK Cursor: fix the flaky UI test
akk list
akk send <conversation-id>: continue with the smaller implementation
akk cancel <conversation-id>
akk recover <conversation-id>
akk restart <conversation-id>
akk close <conversation-id>
```

The plugin also registers the `/akk` slash command for channel surfaces that support OpenClaw native commands:

```text
/akk <task>
/akk codex <task>
/akk claude <task>
/akk cursor <task>
/akk list
/akk status <conversation-id>
/akk send <conversation-id> <message>
/akk cancel <conversation-id>
/akk recover <conversation-id>
/akk restart <conversation-id>
/akk close <conversation-id> [reason]
```

If your OpenClaw config uses a restrictive tool allowlist, allow the tool:

```json5
{
  tools: {
    allow: [
      "agent_knock_knock_delegate",
      "agent_knock_knock_list",
      "agent_knock_knock_status",
      "agent_knock_knock_send",
      "agent_knock_knock_cancel",
      "agent_knock_knock_recover",
      "agent_knock_knock_restart",
      "agent_knock_knock_close"
    ]
  }
}
```

The delegate tool launches the selected coding agent in the background and returns `status: "async_pending"`, `conversation_id`, `state_path`, `event_log_path`, launch status, and executor metadata. OpenClaw should yield after receiving this tool result and wait for the callback turn; follow-up communication should happen through structured protocol callbacks or `agent_knock_knock_send`, not by reading event logs, processes, files, session internals, stdout, or stderr.

The plugin also registers the Gateway method `agent-knock-knock.callback`. Coding-agent callback commands use this method to enqueue a durable next-turn injection for the OpenClaw session. Actionable callbacks such as `question`, `blocked`, `done`, `error`, or any message with `requires_response: true` are delivered into the OpenClaw session through Gateway `chat.send` with `deliver: true`, so OpenClaw receives only the structured protocol message and can route the final reply back through the original channel without polling the raw execution channel.

Coding-agent `done` callbacks mark the AKK conversation `idle`, not closed. Idle conversations remain visible in the default list and can receive `send` follow-ups until they are manually closed or lazily closed by the idle timeout. The default idle timeout is 10080 minutes.

New delegations create a fresh ACPX session by default, using a name like `akk-codex-20260620183511-88811e97`, `akk-claude-...`, or `akk-cursor-...`. This keeps concurrent AKK tasks isolated. Reuse happens through `AKK send <conversation-id>: <message>` against an existing AKK conversation, or by explicitly configuring/passing a fixed coding-agent session.

Background launches also start a small AKK monitor process. The monitor exits when the conversation receives a callback or otherwise leaves the agent-waiting state. If the executor process disappears before a callback, or if no callback arrives before `agentTimeoutMinutes`, the conversation is marked `stalled` and AKK attempts to notify the original OpenClaw session through the callback Gateway route. The default agent timeout is 60 minutes.

Some coding agents may not reliably resume a named ACPX session after their backing process disappears. Executors can opt into an explicit recovery decision flow. In that mode, a failed follow-up send marks the AKK conversation `needs_recovery` instead of automatically replaying history or starting a new session. The user can then choose:

- `AKK recover <conversation-id>`: start a new coding-agent session with AKK's saved protocol history summary plus the pending message.
- `AKK restart <conversation-id>`: start a new coding-agent session with only the pending message.
- `AKK close <conversation-id>`: close the AKK task without recovery.

Codex and Claude Code currently use native named-session recovery through ACPX. Cursor uses the explicit decision flow because its native session resume can be unreliable after the backing process disappears.

Task status can include a safe executor trace with `--trace` or the OpenClaw status tool's `trace: true` parameter. Trace summaries show client lifecycle events, tool call names and statuses, permission-request markers, monitor events, and short sanitized output previews. Agent thinking content is never returned; it is counted and marked as redacted.

## CLI Examples

The CLI is useful for local debugging, tests, and scripting outside OpenClaw.

Create a conversation and print the task payload:

```bash
node dist/src/cli.js new --request "Implement a small feature"
```

Delegate a Codex task through ACPX:

```bash
node dist/src/cli.js delegate \
  --agent codex \
  --request "Implement a small feature" \
  --background
```

Delegate a Cursor task through ACPX:

```bash
node dist/src/cli.js delegate \
  --agent cursor \
  --request "Implement a small feature" \
  --background
```

List open coding-agent tasks:

```bash
node dist/src/cli.js list
```

Inspect a task with a safe executor trace:

```bash
node dist/src/cli.js status \
  --conversation <conversation-id> \
  --trace
```

Send a follow-up message to an existing task:

```bash
node dist/src/cli.js send \
  --conversation <conversation-id> \
  --message "Use the smaller implementation."
```

Request cooperative cancellation of the current in-flight prompt:

```bash
node dist/src/cli.js cancel \
  --conversation <conversation-id>
```

Recover or restart a task that is waiting for an explicit recovery decision:

```bash
node dist/src/cli.js recover \
  --conversation <conversation-id>

node dist/src/cli.js restart \
  --conversation <conversation-id>
```

Close a task locally:

```bash
node dist/src/cli.js close \
  --conversation <conversation-id> \
  --reason "No longer needed"
```

## Approval Behavior

AKK sends ACPX-backed coding-agent prompts with `--approve-all` so ACPX permission requests can proceed without an additional OpenClaw turn.

Claude Code permission requests work with this model. For example, a Claude Code write outside the repository workspace triggers ACPX `session/request_permission`; with `--approve-all`, ACPX approves the request and the write can complete.

Codex does not currently behave the same way for every sensitive operation under AKK. Some Codex sandbox-sensitive actions, such as writing outside the workspace in non-interactive execution, may fail directly with sandbox or permission errors instead of surfacing an ACPX permission request that AKK can approve. In those cases the action is currently unavailable through AKK's background Codex path; prefer Claude Code for tasks that require ACPX-approved filesystem access outside the workspace, or redesign the task to stay inside the configured workspace.

## Development

Build TypeScript sources:

```bash
npm run build
```

Run type checking without writing `dist/`:

```bash
npm run typecheck
```

Run the full test suite. This builds first, then runs the compiled TypeScript tests from `dist/test` against the compiled `dist/src` output:

```bash
npm test
```

Run a two-Claude simulation:

```bash
node scripts/two-claude-weather-test.js --location 广州
```

Run named simulations:

```bash
npm run simulate:architecture
npm run simulate:weather
```

Print a readable transcript from an NDJSON log:

```bash
npm run transcript -- --conversation .agent-knock-knock/conversations/<conversation-id>
```

You can also read a specific event log file:

```bash
npm run transcript -- --log .agent-knock-knock/conversations/<conversation-id>/events.ndjson
```

Include raw model exchange events when debugging prompt/response payloads:

```bash
npm run transcript -- --conversation .agent-knock-knock/conversations/<conversation-id> --include-raw
```

## Storage

Conversation state is stored under the user's home directory so a new OpenClaw session can recover the shared context independently from OpenClaw's own app state:

```text
~/.agent-knock-knock/
  conversations/
    <conversation-id>/
      state.json
      events.ndjson
      <agent>-output.log
  logs/
    runtime-YYYY-MM-DD.ndjson
```

Use `--store-dir <dir>` to override the conversation store location. `--log-dir <dir>` is still accepted as a compatibility alias. `<agent>-output.log` is diagnostic-only; OpenClaw should not read it as part of agent communication.

Runtime logs are diagnostic-only and are safe to use for local troubleshooting. They keep local timestamps, preserve useful absolute paths, redact common secrets, and are cleaned up by retention policy. Use `AKK_LOG_DIR`, `AKK_LOG_LEVEL`, and `AKK_LOG_RETENTION_DAYS` to override the defaults.

## Defaults

- OpenClaw session: `agent:main:main`
- OpenClaw plugin default agent: configured with `defaultAgent`; fallback is `codex`
- Delegated ACPX session: generated per new task, unless explicitly configured with `session`, `codexSession`, `claudeSession`, or `cursorSession`
- CLI `new` fallback Claude session: `bidirectional`
- CLI `new` fallback Codex session: `codex`
- CLI `new` fallback Cursor session: `cursor`
- Codex model, when needed for ChatGPT-account compatibility: pass `model`/`codexModel` such as `gpt-5.5/medium`
- Cursor model, when needed: pass `model`/`cursorModel`
- Gateway URL: `ws://127.0.0.1:18789`
- Agent callback timeout: `60` minutes
- Soft response limit: `50`
- Hard response limit: `100`
- Store directory: `~/.agent-knock-knock/conversations`
- Runtime log directory: `~/.agent-knock-knock/logs`
- Runtime log retention: `14` days

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development, test, and pull request guidance.

## Security

Please do not open public issues for sensitive security reports. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

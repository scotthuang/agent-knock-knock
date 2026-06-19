# agent-knock-knock

Minimal MVP for managed bidirectional delegation between OpenClaw and local coding agents.

OpenClaw acts as the autonomous manager. Claude Code or Codex acts as the autonomous developer. The project provides:

- Structured message protocol
- Conversation state and budget tracking
- NDJSON logging
- Bootstrap prompt generation
- ACPX-backed delegation to Claude Code and Codex
- Task listing, status, follow-up messaging, cooperative cancellation, and local close operations

## Quick Start

Create a conversation and print the task payload:

```bash
node bin/agent-knock-knock.js new --request "Implement a small feature"
```

Start a Claude Code delegation without sending it:

```bash
scripts/bidirectional-delegate.sh --request "Implement a small feature"
```

Create a Codex delegation payload:

```bash
node bin/agent-knock-knock.js delegate \
  --agent codex \
  --request "Implement a small feature"
```

Send the task through `acpx`:

```bash
scripts/bidirectional-delegate.sh --send --request "Implement a small feature"
```

Launch Claude Code in the background and return only protocol metadata:

```bash
node bin/agent-knock-knock.js delegate \
  --background \
  --request "Implement a small feature"
```

List open coding-agent sessions:

```bash
node bin/agent-knock-knock.js list
```

Send a follow-up message to an existing open session:

```bash
node bin/agent-knock-knock.js send \
  --conversation <conversation-id> \
  --message "Use the smaller implementation."
```

Close a task locally without terminating the underlying ACPX session:

```bash
node bin/agent-knock-knock.js close \
  --conversation <conversation-id> \
  --reason "No longer needed"
```

Request cooperative cancellation of the current in-flight prompt without closing the AKK session:

```bash
node bin/agent-knock-knock.js cancel \
  --conversation <conversation-id>
```

Record a Claude Code callback without delivering it to OpenClaw:

```bash
node bin/agent-knock-knock.js callback \
  --state .agent-knock-knock/conversations/<conversation-id>/state.json \
  --record-only \
  --message-json '{"type":"progress","body":"Working on it."}'
```

Install the OpenClaw skill template when ready:

```bash
mkdir -p ~/.openclaw/skills/bidirectional-chat
cp templates/openclaw-skills/bidirectional-chat/SKILL.md ~/.openclaw/skills/bidirectional-chat/SKILL.md
```

## OpenClaw Plugin

This package also includes a native OpenClaw plugin. The plugin registers optional tools that let OpenClaw delegate implementation work to Claude Code or Codex, list open sessions, send follow-up messages, inspect status, request cooperative cancellation, and close sessions without exposing raw terminal output as tool results.

Natural-language routing is designed around the short name `AKK`; lowercase `akk` should be treated the same way. When a user says `AKK` without naming an agent, OpenClaw should delegate to Codex. Use Claude only for explicit requests such as `AKK Claude`.

The plugin also registers the `/akk` slash command for channel surfaces that support OpenClaw native commands:

```text
/akk <task>
/akk codex <task>
/akk claude <task>
/akk list
/akk status <conversation-id>
/akk send <conversation-id> <message>
/akk cancel <conversation-id>
/akk close <conversation-id> [reason]
```

Useful chat-style prompts:

```text
akk: fix the failing tests in this project
AKK Codex: review the current branch and propose a small fix
AKK Claude: review the latest commit
akk list
akk send <conversation-id>: continue with the smaller implementation
akk cancel <conversation-id>
akk close <conversation-id>
```

Install it locally during development:

```bash
openclaw plugins install --link .
openclaw plugins enable agent-knock-knock
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
      "agent_knock_knock_close"
    ]
  }
}
```

The delegate tool launches the selected coding agent in the background and returns `status: "async_pending"`, `conversation_id`, `state_path`, `event_log_path`, launch status, and executor metadata. OpenClaw should yield after receiving this tool result and wait for the callback turn; follow-up communication should happen through structured protocol callbacks or `agent_knock_knock_send`, not by reading event logs, processes, files, session internals, stdout, or stderr.

The plugin also registers the Gateway method `agent-knock-knock.callback`. Coding-agent callback commands use this method to enqueue a durable next-turn injection for the OpenClaw session. Actionable callbacks such as `question`, `blocked`, `done`, `error`, or any message with `requires_response: true` are delivered into the OpenClaw session through Gateway `chat.send` with `deliver: true`, so OpenClaw receives only the structured protocol message and can route the final reply back through the original channel without polling the raw execution channel.

Coding-agent `done` callbacks mark the AKK conversation `idle`, not closed. Idle conversations remain visible in the default list and can receive `send` follow-ups until they are manually closed or lazily closed by the idle timeout. The default idle timeout is 10080 minutes.

## Approval Behavior

AKK sends ACPX-backed coding-agent prompts with `--approve-all` so ACPX permission requests can proceed without an additional OpenClaw turn.

Claude Code permission requests work with this model. For example, a Claude Code write outside the repository workspace triggers ACPX `session/request_permission`; with `--approve-all`, ACPX approves the request and the write can complete.

Codex does not currently behave the same way for every sensitive operation under AKK. Some Codex sandbox-sensitive actions, such as writing outside the workspace in non-interactive execution, may fail directly with sandbox or permission errors instead of surfacing an ACPX permission request that AKK can approve. In those cases the action is currently unavailable through AKK's background Codex path; prefer Claude Code for tasks that require ACPX-approved filesystem access outside the workspace, or redesign the task to stay inside the configured workspace.

Run tests:

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
```

Use `--store-dir <dir>` to override the conversation store location. `--log-dir <dir>` is still accepted as a compatibility alias. `<agent>-output.log` is diagnostic-only; OpenClaw should not read it as part of agent communication.

## Defaults

- OpenClaw session: `agent:main:main`
- OpenClaw plugin default agent: `codex`
- Claude session: `bidirectional`
- Codex session: `codex`
- Codex proxy, when needed: pass `allProxy`/`codexAllProxy` such as `socks5h://127.0.0.1:1082`
- Codex model, when needed for ChatGPT-account compatibility: pass `model`/`codexModel` such as `gpt-5.5/medium`
- Gateway URL: `ws://127.0.0.1:18789`
- Soft response limit: `50`
- Hard response limit: `100`
- Store directory: `~/.agent-knock-knock/conversations`

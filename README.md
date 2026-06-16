# agent-knock-knock

Minimal MVP for managed bidirectional delegation between OpenClaw and Claude Code.

OpenClaw acts as the autonomous manager. Claude Code acts as the autonomous developer. The project provides:

- Structured message protocol
- Conversation state and budget tracking
- NDJSON logging
- Bootstrap prompt generation
- A delegation script that can send the first task to Claude Code through `acpx`

## Quick Start

Create a conversation and print the task payload:

```bash
node bin/agent-knock-knock.js new --request "Implement a small feature"
```

Start a Claude Code delegation without sending it:

```bash
scripts/bidirectional-delegate.sh --request "Implement a small feature"
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

This package also includes a native OpenClaw plugin. The plugin registers the optional tool `agent_knock_knock_delegate`, which lets OpenClaw delegate an implementation task to Claude Code without exposing Claude's raw terminal output as the tool result.

Install it locally during development:

```bash
openclaw plugins install --link .
openclaw plugins enable agent-knock-knock
```

If your OpenClaw config uses a restrictive tool allowlist, allow the tool:

```json5
{
  tools: {
    allow: ["agent_knock_knock_delegate"]
  }
}
```

The tool launches Claude Code in the background and returns `status: "async_pending"`, `conversation_id`, `state_path`, `event_log_path`, launch status, and the Claude session name. OpenClaw should yield after receiving this tool result and wait for the callback turn; follow-up communication should happen through structured protocol callbacks, not by reading event logs, processes, files, session internals, stdout, or stderr.

The plugin also registers the Gateway method `agent-knock-knock.callback`. Claude Code callback commands use this method to enqueue a durable next-turn injection for the OpenClaw session. Actionable callbacks such as `question`, `blocked`, `done`, `error`, or any message with `requires_response: true` are delivered into the OpenClaw session through Gateway `sessions.send`, so OpenClaw receives only the structured protocol message without polling Claude's raw execution channel.

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
      claude-output.log
```

Use `--store-dir <dir>` to override the conversation store location. `--log-dir <dir>` is still accepted as a compatibility alias. `claude-output.log` is diagnostic-only; OpenClaw should not read it as part of agent communication.

## Defaults

- OpenClaw session: `agent:main:main`
- Claude session: `bidirectional`
- Gateway URL: `ws://127.0.0.1:18789`
- Soft response limit: `50`
- Hard response limit: `100`
- Store directory: `<workspace>/.agent-knock-knock/conversations`

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

Conversation state is stored under the workspace so a new OpenClaw session can recover the shared context:

```text
.agent-knock-knock/
  conversations/
    <conversation-id>/
      state.json
      events.ndjson
```

Use `--store-dir <dir>` to override the conversation store location. `--log-dir <dir>` is still accepted as a compatibility alias.

## Defaults

- OpenClaw session: `agent:main:main`
- Claude session: `bidirectional`
- Gateway URL: `ws://127.0.0.1:18789`
- Soft response limit: `50`
- Hard response limit: `100`
- Store directory: `<workspace>/.agent-knock-knock/conversations`

---
name: bidirectional-chat
description: Manage Claude Code through bidirectional autonomous development delegation.
---

# Bidirectional Claude Code Delegation

Use this skill when the user asks OpenClaw to implement a development task with Claude Code as an execution agent.

## Role

You are OpenClaw, the autonomous product manager, requirements owner, and final acceptance decision maker.

You are not a message forwarder and you are not the primary implementation agent. You understand the user's request, define the product intent, make autonomous product decisions, delegate implementation to Claude Code, handle Claude Code's questions or blockers, verify whether the delivered result satisfies the request, and return only the final delivery result or failure reason to the user.

Claude Code is allowed to directly edit files, run commands, fix tests, and complete the implementation.

Claude Code owns engineering execution. OpenClaw owns product direction, requirements interpretation, acceptance criteria, delivery scope, UX behavior, and any compromise or degradation decision.

## Start A Conversation

Run these commands from the `agent-knock-knock` repository root, or from a workspace where `scripts/bidirectional-delegate.sh` is available.

Create or reuse a Claude Code session:

```bash
acpx claude sessions new --name bidirectional
```

Start a managed delegation:

```bash
scripts/bidirectional-delegate.sh --send \
  --token '<gateway-token>' \
  --request '<user task>'
```

If you only want to inspect the payload before sending:

```bash
scripts/bidirectional-delegate.sh --request '<user task>'
```

## Communication Contract

Do not use OpenClaw's internal Claude session tools, such as `sessions_send`, to send the task or follow-up messages directly to Claude Code.

All OpenClaw-to-Claude task delivery must go through `scripts/bidirectional-delegate.sh` or an equivalent `agent-knock-knock delegate` command. This command builds the required Claude bootstrap prompt, embeds the OpenClaw callback command, creates durable conversation state, and records the initial task message.

Claude Code must communicate back to OpenClaw by executing the callback command included in its bootstrap prompt. Claude Code should not rely on OpenClaw's session tools, chat memory, or an out-of-band reply path.

The required routing is:

1. OpenClaw starts delegation with `scripts/bidirectional-delegate.sh --send ...`.
2. The script sends the bootstrap prompt and task to the Claude Code session through `acpx`.
3. Claude Code sends `question`, `progress`, `blocked`, `done`, or `error` messages back by running the provided callback command.
4. OpenClaw answers `question` or `blocked` messages with structured `answer` messages through the same protocol path.

If the delegation script is unavailable, stop and report that the `agent-knock-knock` project path is required. Do not fall back to direct `sessions_send` delivery.

## Message Rules

Use structured JSON messages with these types:

- `task`: delegate work to Claude Code
- `question`: Claude Code asks for a decision
- `answer`: OpenClaw gives a decision
- `progress`: Claude Code reports progress and does not require a response
- `blocked`: Claude Code cannot continue without a decision
- `done`: Claude Code reports completion
- `error`: runtime, tool, or protocol failure
- `control`: budget warning or lifecycle control

Only messages with `requires_response=true` consume response rounds.

## Decision Rules

When Claude Code asks a question or reports a blocker:

1. Decide directly.
2. Answer from the product and acceptance perspective: intended behavior, user-visible result, scope boundary, priority, or acceptable compromise.
3. Prefer keeping scope small and shippable when that still satisfies the user's intent.
4. Avoid asking the user unless the task is impossible to complete safely without new user input.
5. Reply with an `answer` message.

Require Claude Code to ask before it changes product behavior, narrows scope, degrades quality, accepts a workaround, or changes acceptance criteria because of an engineering constraint.

Do not take over implementation details unless they affect the product outcome. Let Claude Code choose local code structure, test mechanics, and ordinary engineering tactics.

## Budget Rules

- Default soft limit: 50 response rounds
- Hard limit: 100 response rounds
- At 30 response rounds, require Claude Code to converge and list remaining work
- At 40 response rounds, warn Claude Code to finish, degrade, or fail within 10 response rounds
- At 50 response rounds, end by default unless completion is clearly near
- At 100 response rounds, force termination and summarize failure

## Final User Reply

Do not replay the internal conversation to the user.

Return:

- What was delivered
- Important files changed
- Verification performed
- Remaining issues, if any
- Failure reason, if the task failed

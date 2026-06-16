# OpenClaw Session Turn Delivery Requirement

## Background

`agent-knock-knock` is an OpenClaw plugin that lets OpenClaw act as a product manager and delegate implementation work to Claude Code.

The desired flow is:

1. OpenClaw decides product requirements.
2. OpenClaw calls `agent_knock_knock_delegate`.
3. Claude Code implements the task asynchronously.
4. Claude Code sends structured callbacks such as `progress`, `question`, `blocked`, or `done`.
5. OpenClaw receives those callbacks in the original session and continues the product-manager conversation.

The callback must not expose Claude Code stdout/stderr or terminal output to OpenClaw. The only communication channel should be the structured protocol message.

## Current Problem

OpenClaw currently lacks a plugin-facing API that can deliver a callback as a real continuation of the current session conversation.

Tested approaches:

- `api.session.workflow.enqueueNextTurnInjection(...)`
  - Queues context for the next turn.
  - Does not wake the session or create a conversational turn by itself.

- `api.session.workflow.scheduleSessionTurn(...)`
  - Has scheduled/cron/announce semantics.
  - The plugin API only supports `deliveryMode: "none" | "announce"`.
  - This does not model an async external engineering agent returning a conversational message to the current PM session.

- Gateway `sessions.send`
  - Does wake the target session and starts an agent run.
  - However, the persisted user message is labeled as CLI sender metadata:

    ```text
    Sender (untrusted metadata):
    {"label":"cli","id":"cli"}
    ```

  - This makes the callback look like a CLI injection or announcement-style message, rather than a normal continuation of the current Control UI/webchat session.

- Gateway `chat.send`
  - Has potentially useful fields such as `originatingChannel` and `systemInputProvenance`.
  - Those fields require admin/system provenance.
  - Calling through `openclaw gateway call` still connects as a CLI client, so it does not solve the sender/provenance problem cleanly.

## Required Capability

OpenClaw should expose a controlled plugin/runtime API or Gateway method that lets a trusted plugin deliver a message into a target session as a conversational next turn.

Suggested plugin API shape:

```ts
api.session.workflow.sendSessionTurn({
  sessionKey: string,
  message: string,
  idempotencyKey?: string,
  provenance?: {
    kind: "plugin_callback" | "external_agent",
    pluginId: string,
    sourceLabel?: string,
    sourceConversationId?: string,
  },
  deliveryMode?: "conversation",
});
```

Suggested Gateway method shape:

```ts
session.turn.send
```

Example params:

```json
{
  "sessionKey": "agent:main:dashboard:...",
  "message": "...structured callback payload...",
  "idempotencyKey": "agent-knock-knock-callback:...",
  "provenance": {
    "kind": "plugin_callback",
    "pluginId": "agent-knock-knock",
    "sourceLabel": "Claude Code",
    "sourceConversationId": "task-20260516T180554Z-d5226a92"
  }
}
```

## Semantic Requirements

The new API should:

1. Trigger the target session's next agent run.
2. Persist the callback as a controlled session-local/plugin callback input, not as `cli` sender metadata.
3. Make the model treat the callback as a valid next message in the current workflow, not as a terminal log, cron announcement, or system notification.
4. Support `idempotencyKey` to avoid duplicate callback delivery and duplicate runs.
5. Be callable from trusted plugins without requiring the plugin to impersonate Control UI/webchat.
6. Preserve structured provenance for UI and audit purposes.
7. Avoid exposing plugin background process stdout/stderr to the model.

Useful provenance categories:

- direct user input
- plugin callback
- cron/scheduled turn
- CLI injection
- inter-session message

## Why This Matters

`agent-knock-knock` needs OpenClaw to wait for an async engineering agent and then continue the original product-manager decision loop when that engineering agent reports back.

This is not a prompt-only issue. The missing piece is an OpenClaw-owned, first-class way for plugins to submit a conversational session turn with trusted plugin provenance.

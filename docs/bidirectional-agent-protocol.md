# Terminal Handoff Protocol

Agent Knock Knock coordinates OpenClaw, a local coding agent, and a human through one visible tmux terminal.

- OpenClaw is the orchestrator, requirements owner, and final acceptance decision maker.
- Codex or Claude Code performs the engineering work inside tmux.
- AKK owns terminal delivery, monitoring, lifecycle state, and callbacks.
- A human can attach to the same tmux pane at any time, continue directly, and later hand control back to OpenClaw.
- AKK sends input only after it verifies the selected agent, pane, process, pane/process working directory, and idle prompt.
- AKK reports approval or completion only when the terminal adapter has reliable evidence. Uncertain states fail closed.

## Identity Model

AKK models shared work as:

```text
tmux terminal / verified process incarnation
└─ native Codex or Claude Code session
   └─ AKK session (session_id)
      ├─ Turn (turn_id)
      └─ Turn (turn_id)
```

- The terminal is the physical pane and coding-agent process incarnation.
- The native session is the continuing context owned by Codex or Claude Code.
- The AKK `session_id` is the authoritative target for ordinary sends into that context.
- A `turn_id` identifies exactly one accepted dispatch through its final monitor and callback state.

Human-friendly selectors such as `only`, `codex`, `claude`, terminal IDs, and `@short-ref` are list/discovery inputs. They must resolve unambiguously to the authoritative `session_id` used by send or the `turn_id` used by managed controls. An unmanaged raw-terminal row may publish its own exact compatibility selector for status or recovery controls; callers must use only the prefilled action and never construct that selector.

## Turn Flow

1. OpenClaw calls ordinary send with a `session_id` and the user-facing request. Initial discovery may first resolve one eligible Codex or Claude Code terminal into an AKK session.
2. AKK verifies that the session is bound to the expected native session, terminal, and idle coding-agent process.
3. AKK creates a unique `turn_id`, writes the request to the verified idle pane, and starts a monitor bound to that Turn, pane, process, and message.
4. The coding agent works in the same terminal that the human can inspect or take over.
5. AKK sends a structured callback containing both `session_id` and `turn_id` to the originating OpenClaw session when it has reliable approval, completion, cancellation, stall, or failure evidence.
6. After completion, another ordinary send to the same `session_id` creates a new Turn without clearing the native coding-agent context.

An ordinary send never targets a completed or historical `turn_id`. If the current Turn is `waiting_for_openclaw` because the coding agent asked a question, OpenClaw uses `respond(turn_id, answer)`; that answer remains inside the same Turn.

If no eligible terminal exists, AKK stops and returns an actionable setup message. It does not launch an invisible replacement agent.

## Message Types

| Type | Purpose |
| --- | --- |
| `task` | OpenClaw starts a new Turn with work for the coding agent. |
| `answer` | OpenClaw answers a question inside a `waiting_for_openclaw` Turn. |
| `progress` | AKK reports reliable non-final progress. |
| `blocked` | AKK reports that the task needs attention. |
| `done` | AKK reports that the current terminal turn completed. |
| `error` | AKK reports a terminal, monitor, callback, or protocol failure. |
| `control` | AKK records lifecycle control such as cancellation or timeout. |

The coding agent does not run a callback command and does not need an AKK-specific hook or plugin. AKK's terminal monitor owns callback delivery.

## Terminal Identity

Each managed Turn is bound to a concrete identity, including:

- coding agent (`codex` or `claude`)
- canonical working directory captured for this pane and Turn
- tmux socket and pane target
- pane and agent process identity
- native session evidence, AKK `session_id`, `turn_id`, and message identity
- monitor owner and lease

AKK revalidates that identity before sending tasks, interrupt keys, or approval input. Stale, changed, ambiguous, or replayed actions are rejected.

## Human Handoff

The tmux pane remains the source of visible truth:

- Attach to tmux to inspect or continue the work yourself.
- Use AKK status for a bounded remote view.
- Send the next request to `session_id` only when AKK verifies the pane is idle; this creates a new Turn.
- Answer an in-flight agent question only through `respond(turn_id, answer)`.
- Interrupt the current turn without closing the pane.
- Renew monitoring only when the same live task remains in that pane.

This makes handoff reversible: OpenClaw and the human operate the same coding-agent session instead of creating parallel, hidden conversations.

Native clear/new/resume operations are separate session-lifecycle features. Ordinary send and Turn creation do not invoke them.

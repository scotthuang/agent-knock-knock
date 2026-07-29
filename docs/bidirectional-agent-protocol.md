# Terminal Handoff Protocol

Agent Knock Knock coordinates OpenClaw, a local coding agent, and a human through one visible tmux terminal.

- OpenClaw is the orchestrator, requirements owner, and final acceptance decision maker.
- Codex or Claude Code performs the engineering work inside tmux.
- AKK owns terminal delivery, monitoring, lifecycle state, and callbacks.
- A human can attach to the same tmux pane at any time, continue directly, and later hand control back to OpenClaw.
- AKK sends input only after it verifies the selected agent, pane, process, pane/process working directory, and idle prompt.
- AKK reports approval or completion only when the terminal adapter has reliable evidence. Uncertain states fail closed.

## Task Flow

1. OpenClaw calls the AKK delegate or send tool with the user-facing task.
2. AKK resolves exactly one eligible Codex or Claude Code pane in tmux.
3. AKK records the managed turn, writes the task to the verified idle pane, and starts a monitor bound to that pane, process, and message.
4. The coding agent works in the same terminal that the human can inspect or take over.
5. AKK sends a structured callback to the originating OpenClaw session when it has reliable approval, completion, cancellation, stall, or failure evidence.
6. OpenClaw may send a follow-up to the same managed terminal conversation.

If no eligible terminal exists, AKK stops and returns an actionable setup message. It does not launch an invisible replacement agent.

## Message Types

| Type | Purpose |
| --- | --- |
| `task` | OpenClaw assigns work to the coding agent. |
| `answer` | OpenClaw supplies a decision or follow-up. |
| `progress` | AKK reports reliable non-final progress. |
| `blocked` | AKK reports that the task needs attention. |
| `done` | AKK reports that the current terminal turn completed. |
| `error` | AKK reports a terminal, monitor, callback, or protocol failure. |
| `control` | AKK records lifecycle control such as cancellation or timeout. |

The coding agent does not run a callback command and does not need an AKK-specific hook or plugin. AKK's terminal monitor owns callback delivery.

## Terminal Identity

Each managed turn is bound to a concrete terminal identity, including:

- coding agent (`codex` or `claude`)
- canonical working directory captured for this pane and managed turn
- tmux socket and pane target
- pane and agent process identity
- managed conversation and message identity
- monitor owner and lease

AKK revalidates that identity before sending tasks, interrupt keys, or approval input. Stale, changed, ambiguous, or replayed actions are rejected.

## Human Handoff

The tmux pane remains the source of visible truth:

- Attach to tmux to inspect or continue the work yourself.
- Use AKK status for a bounded remote view.
- Send a follow-up only when AKK verifies the pane is idle.
- Interrupt the current turn without closing the pane.
- Renew monitoring only when the same live task remains in that pane.

This makes handoff reversible: OpenClaw and the human operate the same coding-agent session instead of creating parallel, hidden conversations.

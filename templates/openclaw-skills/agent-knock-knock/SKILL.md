---
name: agent-knock-knock
description: Control local Codex and Claude Code through shared tmux terminals with Agent Knock Knock.
---

# Agent Knock Knock

Use this skill when the user explicitly invokes `AKK`, `akk`, or `Agent Knock Knock`, or asks OpenClaw to inspect or control a coding-agent terminal previously listed by AKK.

AKK supports Codex and Claude Code running inside tmux. It does not launch a hidden coding-agent runtime. OpenClaw, tmux, AKK, and the coding agent must run as the same OS user.

Treat `AKK` and `akk` the same way.

Default delegation target: plugin-configured `defaultAgent`. If unset, AKK uses Codex. Use Claude only when the user names Claude or it is the configured default.

## Role

OpenClaw interprets the user's request, delegates the requested work, handles actionable callbacks, and reports the outcome. The coding agent performs the engineering work in its existing tmux terminal.

Keep the user's requested scope and approval boundaries. Do not expand a task, approve a permission, interrupt a process, or close a session unless the user request or an explicit trusted policy authorizes that action.

## Chat Routing

Use the native `/akk` command for slash-command syntax. Use the Agent Knock Knock plugin tools for natural-language AKK requests.

Slash command forms:

- `/akk <task>`: send a new task to the configured default agent.
- `/akk codex <task>`: send a new task to Codex.
- `/akk claude <task>`: send a new task to Claude Code.
- `/akk list`: list available and managed coding-agent terminals.
- `/akk doctor`: verify AKK, OpenClaw, tmux, and coding-agent readiness.
- `/akk status [session-selector]`: inspect one managed terminal turn.
- `/akk describe [session-selector]`: summarize one listed session.
- `/akk send <session-selector>: <message>`: send a follow-up to one open terminal session.
- `/akk cancel <session-selector>`: interrupt the current turn without closing its tmux pane.
- `/akk renew <session-selector> [minutes]`: restart monitoring for a stalled but still-live terminal turn.
- `/akk retry-callback <session-selector>`: retry one failed callback delivery.
- `/akk approve <session-selector> --expected-approval-fingerprint <fingerprint>`: approve one exact, current terminal permission request after explicit review. Use only the fresh fingerprint returned for that request.
- `/akk close <session-selector> [reason]`: close AKK's managed conversation without closing the tmux pane. If `AKK list` explicitly reports an orphaned terminal dispatch, inspect the pane first and use the exact `/akk close <terminal-id> --expected-message-id <id>` recovery command it returns; never invent or reuse that message id.

A session selector may be an authoritative full ID, an `@short-ref` returned by `AKK list`, `only`, `latest`, an agent name (`codex` or `claude`), or `<agent>:latest`. Selectors fail closed when the target is missing or ambiguous. Use `latest` only when the user explicitly asks for the newest session.

Natural-language forms:

- `AKK: <task>`: call `agent_knock_knock_delegate` with `request=<task>` and no `agent`.
- `AKK Codex: <task>`: call `agent_knock_knock_delegate` with `agent="codex"`.
- `AKK Claude: <task>`: call `agent_knock_knock_delegate` with `agent="claude"`.
- Requests to list AKK or local coding-agent work: call `agent_knock_knock_list`.
- Requests to inspect current output or ask what a task is doing: call `agent_knock_knock_status`.
- Requests to summarize what a listed session is about: call `agent_knock_knock_describe`.
- Follow-ups for an existing listed session: call `agent_knock_knock_send`.
- Requests to stop current work: call `agent_knock_knock_cancel`.
- Requests to resume monitoring for the same stalled terminal turn: call `agent_knock_knock_renew`.
- Requests to close AKK's record for a terminal turn: call `agent_knock_knock_close`.

## Starting and Reusing Work

Use `agent_knock_knock_delegate` only for a new independent task. AKK must resolve an eligible Codex or Claude Code pane and verify that it is idle before writing the task. If no eligible pane exists, report AKK's setup guidance; do not substitute another execution path.

For a follow-up:

1. Reuse a session only when the user's reference uniquely identifies it.
2. If no ID is supplied, call `agent_knock_knock_list`.
3. If multiple rows match, show their `short_ref`, agent, tmux target, and description and ask the user to choose.
4. If a `terminal_controlled` row was listed, pass its authoritative `id` to `agent_knock_knock_send`.
5. Never guess between multiple terminals or send to a pane that AKK has not verified as idle.

`idle` means the previous managed turn finished while its tmux pane remains open for follow-ups.

Useful examples:

```text
AKK Codex: review the current branch and propose a small fix
AKK Claude: review the latest commit
AKK list
AKK status only
AKK send codex: continue with the smaller implementation
AKK send @a1b2c3d4: run the focused tests
AKK cancel only
AKK renew only 30
AKK approve @a1b2c3d4
```

## Terminal Communication Contract

All OpenClaw-to-agent task delivery must go through Agent Knock Knock plugin tools. Do not use OpenClaw internal session tools, raw tmux commands, shell commands, or another messaging path to bypass AKK's terminal checks.

AKK:

1. Resolves the selected Codex or Claude Code process and tmux pane.
2. Verifies the pane, process identity, workspace, and idle prompt.
3. Types only the user-facing task into the shared terminal.
4. Creates a managed turn bound to that terminal and message.
5. Monitors reliable local evidence and sends callbacks to the originating OpenClaw session.

The coding agent does not run an AKK callback command and does not require an AKK-specific hook or plugin.

After an asynchronous delegate or send operation is accepted, end the OpenClaw turn. Wait for AKK's callback unless the user explicitly requests status.

## Status and Description

For terminal-controlled entries, `agent_knock_knock_status` captures a bounded terminal screen and returns `terminal_screen`. Do not inspect the pane with raw tmux or shell commands unless AKK status is unavailable or fails.

Use `agent_knock_knock_describe` for requests about what a session is doing or why it exists. AKK combines saved conversation history, supported agent-local context, and a conservative terminal fallback with explicit confidence.

## Cancellation, Stalls, and Close

`agent_knock_knock_cancel` uses the adapter's interrupt action—Control-C for Codex or Escape for Claude Code—and leaves the tmux pane open.

Use `agent_knock_knock_renew` only when:

- AKK marked a managed terminal turn `stalled`;
- the same process and task are still live in the same pane; and
- the user wants monitoring to continue without injecting another task.

Closing an AKK conversation does not close the underlying tmux pane or coding-agent CLI.

## Terminal Approval

Approval is a sensitive action.

1. Call `agent_knock_knock_status`.
2. Show the detected request details to the user.
3. Require explicit approval of that exact current request.
4. Call `agent_knock_knock_approve` with the returned `approval_state.fingerprint` as `expected_approval_fingerprint`.

For hookless Claude Code, the callback intentionally omits the raw command. Require the user to inspect the named live tmux pane personally; never approve from a hash or summary alone. Claude manual approval accepts only the strictly recognized one-time **Yes** Bash dialog for the current managed turn. Codex approval also requires the current visible prompt.

Unknown, stale, expired, ambiguous, persistent-permission, replayed, or changed requests must not be approved. Deny or interrupt them with `agent_knock_knock_cancel`, or tell the user to resolve them directly in the terminal.

A trusted, default-disabled plugin `autoApprove` policy may independently approve only an exact configured agent, canonical workspace, and command vector backed by current terminal evidence. The model cannot create or modify that policy.

## tmux Sessions

`agent_knock_knock_list` separates:

- `delegated`: AKK-managed terminal turns;
- `native`: local sessions AKK can describe but cannot control;
- `terminal_controlled`: live Codex or Claude Code sessions in a controllable tmux pane.

When the user asks AKK to control a listed terminal entry, use the authoritative `terminal_controlled` ID. For a Codex process already discovered in tmux, `agent_knock_knock_agent_takeover` may attach a managed conversation only with `strategy="terminal_control"` and the exact terminal target confirmed by AKK. This is the only supported takeover strategy.

Claude Code terminal entries are controlled directly through their listed IDs. AKK does not install or require Claude hooks. Hook-free completion depends on a strictly correlated local Claude transcript turn and fails closed for unknown schemas, background work, or ambiguous identity. Never report completion merely because the pane looks idle.

## Final User Reply

Do not replay internal terminal-monitor or callback details.

Return:

- what was delivered;
- important files or behavior changed;
- verification performed;
- remaining issues, if any; or
- the actionable failure reason.

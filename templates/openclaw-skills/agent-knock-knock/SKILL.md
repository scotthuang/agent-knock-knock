---
name: agent-knock-knock
description: Control local Codex and Claude Code through shared tmux terminals with Agent Knock Knock.
---

# Agent Knock Knock

Use this skill when the user explicitly invokes `AKK`, `akk`, or `Agent Knock Knock`, or asks OpenClaw to inspect or control a coding-agent terminal listed by AKK.

AKK supports Codex and Claude Code that are already running inside tmux. It never launches a coding agent. OpenClaw, tmux, AKK, and the coding agent must run as the same OS user.

Treat `AKK` and `akk` the same way.

## Role

OpenClaw interprets the user's request, sends the requested work into the selected shared terminal, handles actionable callbacks, and reports the outcome. The coding agent performs the engineering work in its existing tmux terminal.

Keep the user's requested scope and approval boundaries. Do not expand a task, approve a permission, interrupt a process, or close a managed record unless the user request or an explicit trusted policy authorizes that action.

## Chat Routing

Use the `/akk` command for slash-command syntax. Use the Agent Knock Knock plugin tools for natural-language AKK requests.

Core slash-command forms:

- `/akk <task>`: send a new task only when exactly one eligible idle coding-agent pane exists across all workspaces.
- `/akk <selector>: <message>`: send a task or follow-up to one exact eligible idle pane.
- `/akk list`: list live coding-agent terminals with their current or recent managed-turn context.
- `/akk status [session-selector]`: inspect one live terminal or managed turn.
- `/akk cancel <session-selector>`: interrupt the current turn without closing its tmux pane.

For the targeted slash form, a selector may be `codex`, `claude`, `only`, `latest`, or an `@short-ref` returned by `AKK list`. The `agent_knock_knock_send` tool additionally accepts an authoritative full ID in its `selector` field. Selectors fail closed when the target is missing or ambiguous. For every send, AKK must revalidate the selected agent PID and tmux pane identity, confirm that the process and pane working directories match, and verify the idle prompt.

AKK discovers eligible panes across workspaces. When more than one target matches, use a selector returned by `AKK list`; never guess based on a workspace name or path.

Natural-language forms:

- `AKK: <task>`: call `agent_knock_knock_send` with `request=<task>` and no `selector`. This succeeds only when exactly one eligible idle pane exists.
- `AKK Codex: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="codex"`.
- `AKK Claude: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="claude"`.
- Requests to list AKK or local coding-agent work: call `agent_knock_knock_list`.
- Requests to inspect current output or ask what a task is doing: call `agent_knock_knock_status`.
- Follow-ups for an existing listed terminal: call `agent_knock_knock_send` with `request=<message>` and the selected terminal reference as `selector`.
- Requests to stop current work: call `agent_knock_knock_cancel`.

## Starting and Reusing Work

Use `agent_knock_knock_send` with `request` and no `selector` only for a new independent task whose target the user left unspecified. AKK must resolve exactly one eligible Codex or Claude Code pane across all workspaces and verify that it is idle immediately before writing the task. If no eligible pane exists, report AKK's setup guidance; do not substitute another execution path.

For a new turn or follow-up:

1. Reuse a terminal or managed turn only when the user's reference uniquely identifies it.
2. If no ID is supplied and more than one eligible pane may exist, call `agent_knock_knock_list`.
3. Treat `terminals[]` as the primary resource list. A terminal's `managed.current_turn` is the only current AKK owner; `managed.recent_turn` and `managed.history` are retained context, not additional terminal owners. Records in `unavailable_managed_turns[]` have no live pane in this snapshot.
4. Read the selected resource's `available_actions`. Use only an action present there, start with its prefilled authoritative arguments, supply every `missing_required` field, and consult the top-level contract for optional fields.
5. Use a terminal row's `send` action for a new turn. Use a managed turn's `follow_up` action to continue that exact turn. Both invoke `agent_knock_knock_send`; add the message as `request` to the prefilled `selector`. Do not add timeout fields for ordinary use; `timeoutSeconds` is unsupported.
6. If multiple terminals match, show their `short_ref`, agent, and tmux target, then ask the user to choose. Never guess or send to a pane that AKK has not verified as idle.

An idle pane is at a verified ready prompt, with no current work or unresolved permission request. A previously completed managed turn alone is not proof that the pane is still idle.

Useful examples:

```text
/akk review the current branch and propose a small fix
/akk codex: inspect the repository and summarize it
/akk @a1b2c3d4: run the focused tests
/akk list
/akk status only
/akk cancel only
```

## Terminal Communication Contract

All OpenClaw-to-agent task delivery must go through Agent Knock Knock plugin tools. Do not use OpenClaw internal session tools, raw tmux commands, shell commands, or another messaging path to bypass AKK's terminal checks.

AKK:

1. Resolves the selected Codex or Claude Code process and tmux pane.
2. Revalidates the expected agent PID and tmux pane identity, confirms that the process and pane working directories match, and verifies the idle prompt.
3. Types only the user-facing task into the shared terminal.
4. Creates a managed turn bound to that terminal and message.
5. Monitors reliable local evidence and sends callbacks to the originating OpenClaw session.

The coding agent does not run an AKK callback command and does not require an AKK-specific hook or plugin.

After an asynchronous send operation is accepted, end the OpenClaw turn. Wait for AKK's callback unless the user explicitly requests status.

## Status

For managed terminal entries, `agent_knock_knock_status` captures a bounded terminal screen and returns `terminal_screen`. Do not inspect the pane with raw tmux or shell commands unless AKK status is unavailable or fails.

## Cancellation and Recovery

`agent_knock_knock_cancel` uses the adapter's interrupt action—Control-C for Codex or Escape for Claude Code—and leaves the tmux pane open.

Use `agent_knock_knock_renew` only when AKK marked the same live terminal turn `stalled`, the process and task remain in the same pane, and the user wants monitoring to continue without terminal input. The contextual slash form is `/akk renew @a1b2c3d4 30`.

Use `agent_knock_knock_retry_callback` only for a `callback_failed` managed turn, for example `/akk retry-callback @a1b2c3d4`.

Use `agent_knock_knock_close` only when the user explicitly wants to close AKK's managed record. If `AKK list` reports an orphaned terminal dispatch, inspect the pane first and use the exact `/akk close <terminal-id> --expected-message-id <id>` recovery command it returns. Never invent or reuse that message ID. Closing a managed record does not close the coding agent or tmux pane.

Use `/akk doctor` only for installation checks or troubleshooting.

## Terminal Approval

Approval is a sensitive action.

1. Call `agent_knock_knock_status`.
2. Show the detected request details to the user.
3. Require explicit approval of that exact current request.
4. Call `agent_knock_knock_approve` with the returned `terminal_status.approval_state.fingerprint` as `expected_approval_fingerprint`.

The equivalent slash command must also include that fresh fingerprint:

```text
/akk approve @a1b2c3d4 --expected-approval-fingerprint <fresh-fingerprint>
```

For hookless Claude Code, the callback intentionally omits the raw command. Require the user to inspect the named live tmux pane personally; never approve from a hash or summary alone. Claude manual approval accepts only the strictly recognized one-time **Yes** Bash dialog for the current managed turn. Codex approval also requires the current visible prompt.

Unknown, stale, expired, ambiguous, persistent-permission, replayed, or changed requests must not be approved. Deny or interrupt them with `agent_knock_knock_cancel`, or tell the user to resolve them directly in the terminal.

A trusted, default-disabled plugin `autoApprove` policy may independently approve only an exact configured agent, command vector, and canonical root listed in `autoApprove.rules[].workspaces`, backed by current terminal evidence. A rule may list multiple workspace roots. These entries are the only workspace boundary for automatic approval; they do not limit pane discovery or manual control. The model cannot create or modify that policy.

## tmux Sessions

`agent_knock_knock_list` is terminal-first: every eligible already-running Codex or Claude Code pane appears once in `terminals[]`, even when retained managed turns reference it. `process_state` reports process liveness and `activity_state` reports the parsed screen state. `managed.current_turn` is the authoritative active turn for that terminal; otherwise `managed.recent_turn` shows the newest retained context. Request `all=true` only when older `managed.history` or retained unavailable history is needed. By default, `unavailable_managed_turns[]` contains attention-needed records whose terminal is unavailable.

The top-level `action_contracts` documents the exact schemas for send, follow-up, status, approve, cancel, renew, retry-callback, and close. `available_actions` is the only authoritative current-action source. `send` on a terminal starts a new managed turn; `follow_up` on a managed turn continues it, using the same send tool with a managed-turn selector. Other actions use `conversation_id`. Start with the prefilled full ID, supply all `missing_required` fields, and use a returned `@short-ref` only for human-facing selection. Availability is a snapshot, so AKK revalidates it before side effects.

Before every terminal operation, AKK revalidates the expected agent PID and tmux pane identity, then confirms that the process and pane working directories match. Sending new work additionally requires a verified idle prompt. Humans can attach to the same tmux session and continue directly at any time.

Claude Code completion depends on a strictly correlated local transcript turn and fails closed for unknown schemas, background work, or ambiguous identity. Never report completion merely because the pane looks idle.

## Final User Reply

Do not replay internal terminal-monitor or callback details.

Return:

- what was delivered;
- important files or behavior changed;
- verification performed;
- remaining issues, if any; or
- the actionable failure reason.

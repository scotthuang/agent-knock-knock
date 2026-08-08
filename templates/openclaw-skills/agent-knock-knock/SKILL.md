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
- `/akk <selector>: <message>`: resolve one exact eligible AKK session and create a new Turn for the message.
- `/akk list`: list live coding-agent terminals with their current or recent managed-turn context.
- `/akk threads <exact-terminal-id>`: list verified native threads that may be resumed in one exact terminal.
- `/akk new-thread <exact-terminal-id>` or `/akk clear-thread <exact-terminal-id>`: switch that idle terminal to a verified clean native context without creating a Turn.
- `/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id|snapshot-handle]`: list candidates when the selection is omitted, or resume one exact snapshot-bound choice without creating a Turn. `previous` also accepts the human phrase `刚才那个`.
- `/akk status [turn-selector]`: inspect one live terminal or exact managed Turn.
- `/akk respond <turn-selector>: <answer>`: answer a coding-agent question inside a `waiting_for_openclaw` Turn.
- `/akk cancel <turn-selector>`: interrupt the exact Turn without closing its tmux pane.

For human-facing ordinary-send slash forms, a selector may be `codex`, `claude`, `only`, `latest`, or an `@short-ref` returned by `AKK list`. These selectors are only a resolution layer and fail closed when the target is missing or ambiguous. A natural-language tool call may preserve a selector explicitly named by the user; otherwise use a list-prefilled selector or omit it and require a unique pane. Never pass a selector as `session_id` or `turn_id`. Native-thread slash commands are stricter: copy the full `terminal_id` returned by `/akk list`, not its `@short-ref`. The slash handler reads a fresh lifecycle snapshot and immediately supplies its compare-and-swap binding token internally; the human never copies that token. Once an AKK session exists, plugin actions prefill the authoritative full `session_id` for ordinary send or `turn_id` for respond and managed controls. The same raw terminal row may advertise status, approval, cancellation, or orphan-close with its own prefilled `conversation_id` compatibility selector. Use only the exact returned action; never infer, copy, or reuse compatibility selectors. For every send, AKK must revalidate the selected agent PID and tmux pane identity, confirm that the process and pane working directories match, and verify the idle prompt.

AKK discovers eligible panes across workspaces. When more than one target matches, use a selector returned by `AKK list`; never guess based on a workspace name or path.

Natural-language forms:

- `AKK: <task>`: call `agent_knock_knock_send` with `request=<task>` and no `selector`. This succeeds only when exactly one eligible idle pane exists.
- `AKK Codex: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="codex"`.
- `AKK Claude: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="claude"`.
- Requests to list AKK or local coding-agent work: call `agent_knock_knock_list`.
- Requests to list resumable native threads for an exact terminal: call `agent_knock_knock_list_resumable_threads` with the terminal row's prefilled `terminal_id`.
- Explicit requests to start a new thread or clear context: call `agent_knock_knock_new_thread` only from an advertised `new_thread` action, preserving its exact `terminal_id` and `expected_binding_token`.
- Explicit requests to recover a listed binding conflict: call `agent_knock_knock_reconcile_binding` only from that terminal row's advertised `reconcile_binding` action, preserving its exact terminal, Session revision, binding token, and terminal token. This detaches the stale/conflicting binding without adopting the live thread; refresh the list before any later control.
- Explicit requests to resume prior native context: first call `agent_knock_knock_list_resumable_threads`; then call `agent_knock_knock_resume_thread` with the same exact `terminal_id`, the complete UUID and opaque `candidate_token` from one `resumable=true` row, and the `expected_binding_token` from that same result. For “previous” / “刚才那个”, proceed only when that fresh result contains `previous.available_actions.resume_thread`, and use that exact action; never substitute the newest row.
- Requests to inspect current output or ask what a task is doing: call `agent_knock_knock_status`.
- A later request for an existing listed AKK session: call `agent_knock_knock_send` with its authoritative `session_id` and `request=<message>`; this creates a new Turn in the same native context.
- Requests to continue the current thread are ordinary sends, not lifecycle actions.
- An answer to a coding-agent question in a `waiting_for_openclaw` Turn: call `agent_knock_knock_respond` with its authoritative `turn_id` and `request=<answer>`.
- Requests to stop current work: call `agent_knock_knock_cancel`.

## Sessions and Turns

AKK's identity hierarchy is terminal → native Codex or Claude Code session → AKK session → Turns. Once the AKK session exists, its `session_id` is the ordinary-send target. Each accepted send creates a distinct `turn_id` without clearing the native agent context. A `turn_id` is only for history, callbacks, respond, status, approval, cancellation, renewal, callback retry, and close.

Use `agent_knock_knock_send` with `request` and neither `session_id` nor `selector` only when the target is unspecified. AKK must resolve exactly one eligible Codex or Claude Code pane across all workspaces, attach or discover its AKK session, and verify that it is idle immediately before writing the request. If no eligible pane exists, report AKK's setup guidance; do not substitute another execution path.

For ordinary send or an in-flight answer:

1. Reuse an AKK session only when the user's reference uniquely identifies its verified native session and terminal incarnation.
2. If no ID is supplied and more than one eligible pane may exist, call `agent_knock_knock_list`.
3. Treat `terminals[]` as the primary resource list. Its managed context exposes `session_id`; `managed.current_turn` is the only current AKK owner, while `managed.recent_turn` and `managed.history` are retained Turn history. Records in `unavailable_managed_turns[]` have no live pane in this snapshot.
4. Read the selected resource's `available_actions`. Use only an action present there, start with its prefilled authoritative arguments, supply every `missing_required` field, and consult the top-level contract for optional fields.
5. For an existing managed Session, use `send` with its prefilled `session_id`; it creates a new Turn. For first attach only, use a discovery selector explicitly named by the user or the selected unmanaged raw-terminal row's prefilled `selector`. Never infer or reuse a selector. Use `respond` with its prefilled `turn_id` only when that Turn is explicitly `waiting_for_openclaw`; the answer stays in the same Turn. Add the text as `request`. Do not add timeout fields for ordinary use; `timeoutSeconds` is unsupported.
6. If multiple terminals match, show their `short_ref`, agent, and tmux target, then ask the user to choose. Never guess or send to a pane that AKK has not verified as idle.

An idle pane is at a verified ready prompt, with no current work or unresolved permission request. A previously completed managed turn alone is not proof that the pane is still idle.

Do not treat ordinary send as native clear, new-session, fork, branch, side thread, status probe, or resume. Do not send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, `/btw`, Claude `/branch`, or any other first-line native slash command as ordinary task or answer text. Native lifecycle tools own supported keystrokes, capability checks, serialization, identity verification, and binding changes; express other requests in natural language or leave unsupported native commands to a human in tmux. Each successful lifecycle transition creates no Turn.

For native-thread lifecycle discovery or mutation:

1. Start from the exact terminal row's currently advertised `list_resumable_threads` or `new_thread` action. Listing is read-only, requires only the full `terminal_id`, and creates no Turn.
2. Before either mutation, `new_thread` or `resume_thread`, the terminal must be verified idle and have no active or unresolved Turn. Preserve the exact `expected_binding_token` from the same current terminal action or lifecycle-list result. Never construct, guess, or reuse it after another terminal action.
3. For resume, list candidates first and invoke only the `resume_thread` action advertised by one candidate row with `resumable=true`. Preserve that row's complete `native_thread_id` and opaque `candidate_token`; never select by title, preview, recency, or a partial UUID, and never combine values from different snapshots. Structured tool calls always use the exact full action. Human slash-command numbers and collision-safe short IDs refer only to the latest candidate snapshot displayed in that same OpenClaw session; an opaque handle names one exact snapshot, and all expire or fail after relevant terminal state changes. If the user says “previous” or “刚才那个”, use only an advertised `previous` action derived from the latest committed transition; if absent, explain that AKK cannot prove it and ask the user to list/select instead.
4. Treat mutation success as a Session/native-context transition, not as task delivery. It creates or activates an AKK `session_id`, advances the terminal binding generation, and creates no `turn_id`. The next ordinary send creates the first Turn in that context.
5. If the agent/version is unsupported, a candidate is ambiguous or active elsewhere, the token is stale, or post-transition identity cannot be verified, fail closed and report the error. Do not fall back to raw terminal commands.

Useful examples:

```text
/akk review the current branch and propose a small fix
/akk codex: inspect the repository and summarize it
/akk @a1b2c3d4: run the focused tests
/akk list
/akk threads terminal:v2:tmux:codex:akk-work:0.0:1234
/akk new-thread terminal:v2:tmux:codex:akk-work:0.0:1234
/akk resume-thread terminal:v2:tmux:codex:akk-work:0.0:1234 previous
/akk resume-thread terminal:v2:tmux:codex:akk-work:0.0:1234 2
/akk resume-thread terminal:v2:tmux:codex:akk-work:0.0:1234 11111111-1111-4111-8111-111111111111
/akk status only
/akk respond @a1b2c3d4: use the existing JSON format
/akk cancel only
```

## Terminal Communication Contract

All OpenClaw-to-agent task delivery must go through Agent Knock Knock plugin tools. Do not use OpenClaw internal session tools, raw tmux commands, shell commands, or another messaging path to bypass AKK's terminal checks.

AKK:

1. Resolves the authoritative AKK session to its selected Codex or Claude Code native session, process, and tmux pane.
2. Revalidates the expected agent PID and tmux pane identity, confirms that the process and pane working directories match, and verifies the idle prompt.
3. Types only the user-facing task into the shared terminal.
4. Creates a unique managed `turn_id` bound to the AKK `session_id`, terminal incarnation, and message.
5. Monitors reliable local evidence and sends callbacks to the originating OpenClaw session.

The coding agent does not run an AKK callback command and does not require an AKK-specific hook or plugin.

After an asynchronous send operation is accepted, end the OpenClaw turn. Wait for AKK's callback unless the user explicitly requests status.

## Status

For managed terminal entries, `agent_knock_knock_status` captures a bounded terminal screen and returns `terminal_screen`. Do not inspect the pane with raw tmux or shell commands unless AKK status is unavailable or fails.

## Cancellation and Recovery

`agent_knock_knock_cancel` uses the adapter's interrupt action—Control-C for Codex or Escape for Claude Code—and leaves the tmux pane open.

Use `agent_knock_knock_renew` only when AKK marked the same live terminal Turn `stalled`, the process and Turn remain in the same pane, and the user wants monitoring to continue without terminal input. The contextual slash form is `/akk renew @a1b2c3d4 30`.

Use `agent_knock_knock_retry_callback` only for a `callback_failed` managed turn, for example `/akk retry-callback @a1b2c3d4`.

Use `agent_knock_knock_close` only when the user explicitly wants to close AKK's managed record. If `AKK list` reports an orphaned terminal dispatch or lifecycle transition, inspect the pane first and use the exact `/akk close <terminal-id> ...` recovery command it returns. That command contains exactly one fresh `--expected-message-id <id>` or `--expected-transition-id <id>` fence. Never invent, substitute, or reuse the fence. Closing a managed record does not close the coding agent or tmux pane.

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

`agent_knock_knock_list` is terminal-first: every eligible already-running Codex or Claude Code pane appears once in `terminals[]`, even when retained managed Turns reference it. The resource chain is terminal → verified native session → managed AKK `session_id` → Turns. `process_state` reports process liveness and `activity_state` reports the parsed screen state. `managed.current_turn` is the authoritative active Turn for that terminal; otherwise `managed.recent_turn` shows the newest retained context. Request `all=true` only when older `managed.history` or retained unavailable history is needed. By default, `unavailable_managed_turns[]` contains attention-needed records whose terminal is unavailable.

The top-level v6 `action_contracts` summarizes each tool's managed target and its narrow compatibility inputs; `available_actions` is the authoritative current-action source after listing. An existing managed Session's ordinary `send` targets `session_id` and starts a new managed Turn. On first attach only, `selector` may preserve a discovery target explicitly named by the user or the exact selector prefilled by an unmanaged raw-terminal row; it must never be passed as `session_id`. `respond` and every managed control target `turn_id`; `respond` is offered only for a Turn waiting on OpenClaw. The read-only `list_resumable_threads` action is advertised on the terminal row, requires only its full `terminal_id`, and returns a fresh `expected_binding_token` plus candidate rows. The `new_thread` mutation is advertised on the terminal row and requires that terminal ID and token; each resumable candidate row advertises its own `resume_thread` mutation with the same snapshot token, its complete `native_thread_id`, and its opaque `candidate_token`. A conflict-only `reconcile_binding` action may be advertised for one exact, idle binding conflict; it preserves the listed Session revision, binding token, and terminal token, then CAS-detaches the old binding without adopting the live thread, sending terminal input, or creating a Turn. A top-level `previous` block, when present, is the only authority for a “previous/刚才那个” request. Number, short ID, and snapshot handle fields are human-facing navigation only; never pass them to the exact resume tool. Lifecycle discovery and mutations never create a Turn. A raw terminal may be controlled only through the exact action that its own row advertises; prefilled compatibility selectors, lifecycle IDs, and tokens must never be inferred, copied from another row, or reused from another snapshot. Start with the prefilled full argument, supply all `missing_required` fields, and use a returned `@short-ref` only for human-facing ordinary-send selection. Availability is a snapshot, so AKK revalidates it before side effects.

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

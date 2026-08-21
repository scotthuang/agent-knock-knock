---
name: agent-knock-knock
description: Control local Codex and Claude Code through shared tmux or Herdr terminals with Agent Knock Knock.
---

# Agent Knock Knock

Use this skill when the user explicitly invokes `AKK`, `akk`, or `Agent Knock Knock`, or asks OpenClaw to inspect or control a coding-agent terminal listed by AKK.

AKK supports Codex and Claude Code that are already running inside tmux or local Herdr `0.8.0`. It never launches a coding agent. OpenClaw, the terminal host, AKK, and the coding agent must run as the same OS user.

Treat `AKK` and `akk` the same way.

## Role

OpenClaw interprets the user's request, sends the requested work into the selected shared terminal, handles actionable callbacks, and reports the outcome. The coding agent performs the engineering work in its existing tmux or Herdr terminal.

Keep the user's requested scope and approval boundaries. Do not expand a task, approve a permission, interrupt a process, or close a managed record unless the user request or an explicit trusted policy authorizes that action.

## Chat Routing

Use the `/akk` command for slash-command syntax. Use the Agent Knock Knock plugin tools for natural-language AKK requests.

Core slash-command forms:

- `/akk <task>`: send a new task only when exactly one eligible idle coding-agent pane exists across all workspaces.
- `/akk <selector>: <message>`: resolve one exact eligible AKK session and create a new Turn for the message.
- `/akk list`: list live coding-agent terminals, their current or recent managed-turn context, and durable Terminal Watches.
- `/akk watch <exact-terminal-id>`: observe one exact supported task that the human already started in the TUI, without sending input or creating a Session or Turn.
- `/akk unwatch <watch-id>`: cancel only that observation; do not interrupt or otherwise change the TUI task.
- `/akk threads <exact-terminal-id>`: list verified native threads that may be resumed in one exact terminal.
- `/akk new-thread <exact-terminal-id>` or `/akk clear-thread <exact-terminal-id>`: switch that idle terminal to a verified clean native context without creating a Turn.
- `/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id|snapshot-handle]`: list candidates when the selection is omitted, or resume one exact snapshot-bound choice without creating a Turn. `previous` also accepts the human phrase `刚才那个`.
- `/akk status [turn-selector|terminal-watch-id]`: inspect one live terminal, exact managed Turn, or exact Terminal Watch.
- `/akk respond <turn-selector>: <answer>`: answer a coding-agent question inside a `waiting_for_openclaw` Turn.
- `/akk cancel <turn-selector>`: interrupt the exact Turn without closing its terminal pane.

For human-facing ordinary-send slash forms, a selector may be `codex`, `claude`, `only`, `latest`, or an `@short-ref` returned by `AKK list`. These selectors are only a resolution layer and fail closed when the target is missing or ambiguous. A natural-language tool call may preserve a selector explicitly named by the user; otherwise use a list-prefilled action or omit the target and require a unique pane. Never pass a selector as `session_id` or `turn_id`. The v15 contract names a send with `session_id` `session_exact`: it is session-scoped and must remain pinned to that exact native context. It names a listed follow-current send `terminal_follow_current`: preserve its exact full terminal `selector` and fresh `expected_terminal_token` together; this expresses the human's intent to operate the current pane even when its foreground Codex UUID is not yet attributable. Never add that token to `session_id`, infer it, copy it to another row, or reuse it after another terminal action. Native-thread slash commands are stricter: copy the full `terminal_id` returned by `/akk list`, not its `@short-ref`. The slash handler reads a fresh lifecycle snapshot and immediately supplies its compare-and-swap binding token internally; the human never copies that token. Plugin actions prefill the authoritative arguments for ordinary send and the exact `turn_id` for respond and managed controls. A terminal-scoped manual Codex approval may instead prefill its exact `conversation_id` and `expected_terminal_token`; preserve both and use only the latest status fingerprint after explicit user confirmation. Use only the exact returned action; never infer, copy, or reuse compatibility selectors. For every side effect, AKK must revalidate the selected agent PID and provider-owned terminal identity, confirm that the process and pane working directories match, and revalidate the relevant composer or approval prompt.

v15 generalizes human-priority Codex actions. A listed terminal-scoped ordinary send may proceed when the pane/process and complete open-rollout candidate inventory are exact even though no single foreground UUID can be selected, including a supported manual `/clear` whose new logical thread appears before its rollout materializes. The complete exact inventory domain binds the provider terminal, PID and process birth, workspace and canonical endpoint, and every open rollout's UUID, descriptor, device, inode, canonical path, and pre-submit byte offset. Native foreground resolution may be unavailable only when that independent domain is complete and exact. A `/clear` resume hint is only an advisory routing and diagnostic signal. It is not token, UUID, foreground, rollout, or acceptance authority, and its disappearance does not invalidate an otherwise fresh candidate action. Under the terminal lock, AKK isolates the predecessor, creates a separate zero-UUID provisional Session and Turn, sends the real task once, and binds only the single candidate rollout that durably accepts that exact request. A rollout-backed Codex row therefore advertises `terminal_follow_current`, not `session_exact`; a cached or direct `session_exact` attempt revalidates under the terminal lock, rejects before task text, and never downgrades itself to the follow-current path. Use only the freshly listed selector/token action. A status-card-only zero-rollout first task remains a special case of the same rule. Until promotion commits, strict `session_id` send, `respond`, managed `approve`, `cancel`, native lifecycle, callback delivery, and `native_inspect` remain unavailable. If delivery or acceptance is uncertain, do not retry automatically. Explicit close abandons the missing result/callback and may restore only future-send liveness while its exact resolved close ledger, append-only uncertain receipt, frozen predecessor history, absent old rollout, and unclaimed candidate inventory remain authoritative. v15 may also expose one terminal-scoped manual Codex approval when the visible prompt and either its exact AKK dispatch owner or one released-owner managed Session are exact but rollout attribution is unavailable. The released-owner form covers work the human entered directly in the pane; it does not attribute the key to a Turn, change Session identity, or create a durable approval receipt. It never participates in auto-approval, and an uncertain result must not be retried blindly.

The historical v16 `action_contracts` scoped manual approval fingerprints to the approval prompt rather than the whole terminal screen. The stable authority is the adapter-isolated exact unredacted prompt region plus terminal/process identity, decision keys and label, prompt kind, working directory, reason/detail, and any request or policy evidence. The whole-screen digest and redacted excerpt are diagnostic only, so output outside that region may scroll between the initial capture, user authorization, dispatch reservation, and final key without invalidating an otherwise identical prompt. Any change within the exact region—including a command, secret, option, highlighted choice, prompt kind, or request identity—or a change in the bound process, working directory, or request evidence requires a fresh review and sends zero keys under the stale fingerprint. If the adapter cannot isolate one complete bounded prompt region, approval remains unavailable. Never expose, persist, log, infer, or reconstruct the raw prompt evidence. A v15 whole-screen fingerprint or terminal-scoped approval token is stale after upgrade; refresh `list` and `status` before approval.

AKK discovers eligible panes across workspaces. When more than one target matches, use a selector returned by `AKK list`; never guess based on a workspace name or path.

Natural-language forms:

- `AKK: <task>`: call `agent_knock_knock_send` with `request=<task>` and no `selector`. This succeeds only when exactly one eligible idle pane exists.
- `AKK Codex: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="codex"`.
- `AKK Claude: <task>`: call `agent_knock_knock_send` with `request=<task>` and `selector="claude"`.
- Requests to list AKK or local coding-agent work: call `agent_knock_knock_list`.
- Requests to observe work the human started directly in the Codex or Claude Code TUI: first call `agent_knock_knock_list`, then call `agent_knock_knock_watch` only from that exact active terminal row's freshly advertised `watch` action. Preserve its complete `terminal_id` and `expected_binding_token`; never construct or reuse them.
- Requests to inspect an existing Terminal Watch: call `agent_knock_knock_status` with its authoritative `watch_id`. Requests to stop observing it: call `agent_knock_knock_unwatch` with that same `watch_id`. Never substitute a Session, Turn, terminal selector, or short reference.
- Requests to continue in the current terminal context after the human may have run `/clear`, `/new`, `/resume`, or an equivalent native operation: first call `agent_knock_knock_list`, then use only that exact terminal row's advertised `send`. Preserve its full `selector` and `expected_terminal_token`, add the user's text as `request`, and do not substitute the stale `session_id`.
- Requests for the coding agent's native Codex status card or Claude Status panel: first call `agent_knock_knock_list`, then call `agent_knock_knock_native_inspect` only when the exact terminal row advertises `native_inspect`. Preserve its complete `terminal_id`, `inspection="status"`, and `expected_binding_token`; do not substitute AKK Turn status or ordinary send.
- Requests to list resumable native threads for an exact terminal: call `agent_knock_knock_list_resumable_threads` with the terminal row's prefilled `terminal_id`.
- Explicit requests to start a new thread or clear context: call `agent_knock_knock_new_thread` only from an advertised `new_thread` action, preserving its exact `terminal_id` and `expected_binding_token`.
- Explicit requests for low-level recovery of a listed binding conflict: call `agent_knock_knock_reconcile_binding` only from that terminal row's advertised `reconcile_binding` action, preserving its exact terminal, Session revision, binding token, and terminal token. This detaches the stale/conflicting binding without adopting the live thread; refresh the list before any later control. Do not use it in place of an advertised terminal-scoped `send` when the user simply wants to continue in the human-selected current context.
- Explicit requests to resume prior native context: first call `agent_knock_knock_list_resumable_threads`; then call `agent_knock_knock_resume_thread` with the same exact `terminal_id`, the complete UUID and opaque `candidate_token` from one `resumable=true` row, and the `expected_binding_token` from that same result. For “previous” / “刚才那个”, proceed only when that fresh result contains `previous.available_actions.resume_thread`, and use that exact action; never substitute the newest row.
- Requests to inspect current output or ask what a task is doing: call `agent_knock_knock_status`.
- A later ordinary request: refresh `agent_knock_knock_list` and use only the selected terminal row's exact advertised `send`. If it pre-fills `session_id`, preserve that `session_exact` target; if it pre-fills `selector` plus `expected_terminal_token`, preserve both for `terminal_follow_current`. Add only `request=<message>` and never substitute a retained Session or Turn identity for the listed action.
- Requests to continue the current terminal context are ordinary terminal-scoped sends, not lifecycle actions. Use only a freshly advertised action carrying the exact terminal selector and token when a human-driven switch is present.
- An answer to a coding-agent question in a `waiting_for_openclaw` Turn: call `agent_knock_knock_respond` with its authoritative `turn_id` and `request=<answer>`.
- Requests to stop current work: call `agent_knock_knock_cancel`.

## Sessions and Turns

AKK's identity hierarchy is terminal → native Codex or Claude Code session → AKK session → Turns. When an advertised action contains `session_id`, it is the strict ordinary-send target for one exact native context. A terminal-scoped follow-current action is deliberately different: its exact `selector` plus `expected_terminal_token` lets the user hand the pane's currently verified context back to AKK after a safe human-driven switch. Each accepted send creates a distinct `turn_id` without clearing the native agent context. A `turn_id` is only for history, callbacks, respond, status, approval, cancellation, renewal, callback retry, and close.

Use `agent_knock_knock_send` with `request` and neither `session_id` nor `selector` only when the target is unspecified. AKK must resolve exactly one eligible Codex or Claude Code pane across all workspaces, attach or discover its AKK session, and verify that it is idle immediately before writing the request. If no eligible pane exists, report AKK's setup guidance; do not substitute another execution path.

For ordinary send or an in-flight answer:

1. Reuse an AKK session only when the user's reference uniquely identifies its verified native session and terminal incarnation.
2. If no ID is supplied and more than one eligible pane may exist, call `agent_knock_knock_list`.
3. Treat `terminals[]` as the primary resource list. Its managed context exposes `session_id`; `managed.current_turn` is the only current AKK owner, while `managed.recent_turn` and `managed.history` are retained Turn history. Records in `unavailable_managed_turns[]` have no live pane in this snapshot.
4. Read the selected resource's `available_actions`. Use only an action present there, start with its prefilled authoritative arguments, supply every `missing_required` field, and consult the top-level v17 `action_contracts` for optional fields. The only additional action sources are a terminal row's `handoff_decision.choices.take_over_current.action` and an exact `blocking_turns[].recovery_action`: use either only after explicit user confirmation, preserve the complete action unchanged, and refresh the list immediately afterward.
5. If an existing managed Session advertises `send` with a prefilled `session_id`, use that exact action; it creates a new Turn strictly in that Session's native context. If the selected row instead advertises a follow-current `send`, preserve its full terminal `selector` and `expected_terminal_token` exactly and add the text as `request`; this action may adopt a safe human-driven handoff or send once within an exact, complete Codex rollout-candidate inventory before binding the uniquely accepting native thread. The status-card-only first-task path remains the zero-rollout special case. Legacy first attach may use a discovery selector explicitly named by the user or the selected unmanaged raw-terminal row's prefilled `selector`. Never infer or reuse a selector or token. Use `respond` with its prefilled `turn_id` only when that Turn is explicitly `waiting_for_openclaw`; the answer stays in the same Turn. Do not add timeout fields for ordinary use; `timeoutSeconds` is unsupported.
6. If multiple terminals match, show their `short_ref`, agent, provider, and terminal target, then ask the user to choose. If a human switch has an unresolved Turn, ambiguous ownership, or unverifiable identity and no follow-current send is advertised, report that blocker and ask the user which context to resolve; never guess, supersede active work, or bypass the fence.

An idle pane is at a verified ready prompt, with no current work or unresolved permission request. A previously completed managed turn alone is not proof that the pane is still idle.

Do not treat ordinary send as native clear, new-session, fork, branch, side thread, status probe, or resume. Do not send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, `/btw`, Claude `/branch`, or any other first-line native slash command as ordinary task or answer text. Dedicated native lifecycle and inspection tools own their closed commands, capability checks, serialization, identity verification, and binding fences; express other requests in natural language or leave unsupported native commands to a human in the terminal UI. Each successful lifecycle transition creates no Turn, and native inspection creates no Session or Turn.

## Terminal Watch

Terminal Watch is only for one task that the human started directly in the live TUI. The required sequence is human starts the task in Codex or Claude Code → fresh `agent_knock_knock_list` or `/akk list` while it is working or awaiting approval → copy only that row's complete advertised `watch` action → retain the returned `watch_id` for status or unwatch. The slash form `/akk watch <exact-terminal-id>` performs its own fresh list lookup and requires that exact row to still advertise `watch`.

The Watch is an independent durable schema-v1 aggregate, not a Conversation, Session, Turn, dispatch receipt, monitor owner, or terminal-input authority. It neither sends input nor adopts, claims, reserves, blocks, interrupts, or continues the human's task. `unwatch` marks only the Watch `cancelled`; it does not press a key or stop the coding agent.

Its authority is the exact terminal endpoint and process incarnation, native thread/task, supported agent behavior profile, and privacy-safe provider anchor captured at creation. Codex binds the exact rollout file plus the current human task's request/turn byte boundaries. Claude binds the exact transcript file, root prompt, and current-turn byte boundaries. Process, endpoint, native-thread, file identity, truncation/replacement, boundary, successor-task, version, fingerprint, missing-evidence, or ambiguity drift invalidates the Watch. Never follow the pane's current task or reconstruct a new anchor.

Approval is notification-only. Show the user that the watched TUI needs attention and tell them to inspect and decide there. Never call an approve tool for a Watch, send approval keys, or apply `autoApprove`; a new exact approval fingerprint is notified once while the Watch remains active. Terminal outcomes settle once. The durable outbox uses deterministic notification IDs/idempotency and leased retry, so startup and periodic supervision can safely recover callback delivery after AKK, OpenClaw, or Gateway restart.

The current plugin registers 16 OpenClaw tools and list action-contract v17. Watch uses `agent_knock_knock_watch`, `agent_knock_knock_status({watch_id})`, and `agent_knock_knock_unwatch`; its internal CLI boundary is `watch-terminal`, `watch-status`, `unwatch-terminal`, and `reconcile-watches`.

For native status inspection:

1. Use only a current `available_actions.native_inspect` entry. Its structured arguments are authoritative and complete; never construct or reuse them.
2. Supported exact profiles are Codex 0.146.0/0.146.1/0.147.0/0.148.0 and Claude Code 2.1.218/2.1.226/2.1.237 `inspection="status"`. Claude success includes parsing and safely dismissing the newly opened Status panel. The tool does not accept `/status` text or any arbitrary command string. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and unsupported versions remain unavailable. Never automate bare Codex `/usage`: it opens an interactive menu whose later Enter can select an account-side usage-limit reset.
3. Treat this as terminal input even though the native command is read-only. AKK requires an idle empty composer, fresh binding token, exact PID/process/pane/cwd/version identity, and no conflicting Turn, transition, dispatch, approval, or owner.
4. Codex `/status` requires an exact viewport of at least 80 columns so the full Session UUID can be proven. That pre-UUID gate applies to native inspection, lifecycle, and strict Session operations that must know the UUID before terminal input. An otherwise eligible terminal-scoped ordinary task may send once and bind from exact native acceptance afterward, so it does not run `/status` or fail merely because the pane is narrow.
5. The result is valid only when AKK proves one fresh bounded native status result and the pane returns to idle. On an uncertain or unproven submission, do not retry, send Enter, clear the composer, or bypass AKK with raw terminal input.
6. Native inspection creates no AKK Session, Turn, receipt, monitor, callback, or response round.

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

All OpenClaw-to-agent task delivery must go through Agent Knock Knock plugin tools. Do not use OpenClaw internal session tools, raw terminal-provider commands, shell commands, or another messaging path to bypass AKK's terminal checks.

AKK:

1. Resolves the authoritative AKK session to its selected Codex or Claude Code native session, process, and terminal pane.
2. Revalidates the expected agent PID and provider-owned terminal identity, confirms that the process and pane working directories match, and verifies the idle prompt.
3. Types only the user-facing task into the shared terminal.
4. Creates a unique managed `turn_id` bound to the AKK `session_id`, terminal incarnation, and message.
5. Monitors reliable local evidence and sends callbacks to the originating OpenClaw session.

The coding agent does not run an AKK callback command and does not require an AKK-specific hook or plugin.

After an asynchronous send operation is accepted, end the OpenClaw turn. Wait for AKK's callback unless the user explicitly requests status.

## Status

For managed terminal entries, `agent_knock_knock_status` captures AKK Turn state plus a bounded terminal screen and returns `terminal_screen`. With `watch_id`, it returns the exact durable Terminal Watch and describes it as observed external work; it must not imply AKK sent or adopted the task. Neither form actively executes the coding agent's native `/status`. Use `agent_knock_knock_native_inspect` only for a terminal row's advertised, version-scoped native status action. Do not inspect the pane with raw provider or shell commands unless the relevant AKK inspection is unavailable or fails.

## Cancellation and Recovery

`agent_knock_knock_cancel` uses the adapter's interrupt action—Control-C for Codex or Escape for Claude Code—and leaves the terminal pane open.

Use `agent_knock_knock_renew` only when AKK marked the same live terminal Turn `stalled`, the process and Turn remain in the same pane, and the user wants monitoring to continue without terminal input. The contextual slash form is `/akk renew @a1b2c3d4 30`.

Use `agent_knock_knock_retry_callback` only for a `callback_failed` managed turn, for example `/akk retry-callback @a1b2c3d4`.

Use `agent_knock_knock_close` only when the user explicitly wants to close AKK's managed record. If `AKK list` reports an orphaned terminal dispatch or lifecycle transition, inspect the pane first and use the exact `/akk close <terminal-id> ...` recovery command it returns. That command contains exactly one fresh `--expected-message-id <id>` or `--expected-transition-id <id>` fence. Never invent, substitute, or reuse the fence. If a terminal row exposes `blocking_turns[]`, do not send, inspect natively, or mutate lifecycle state; present the exact collateral blocking Turn and invoke its nested Store-only `recovery_action` only after explicit user confirmation, then refresh the list. An active human-handoff source Turn is deliberately excluded from this generic recovery list. If a verified human native-thread switch conflicts with one active Turn, do not redirect or close it automatically. Present `handoff_decision` to the user. Only after the user chooses takeover may you invoke the complete nested `take_over_current.action`, including its exact `turn_id`, `reason="superseded_by_human_context_switch"`, and `expected_handoff_token`. This snapshot-bound close sends no terminal input. Refresh `agent_knock_knock_list` afterward and use only its new follow-current send. If the user keeps the source Turn, make no AKK mutation; ask them to restore its native thread in the TUI and then refresh. Closing a managed record does not close the coding agent or terminal pane.

Use `/akk doctor` only for installation checks or troubleshooting.

## Terminal Approval

Approval is a sensitive action.

A Terminal Watch approval callback is not an approval action. Notify the user and require them to inspect and decide in the live TUI; never continue with the steps below for a `watch_id`.

1. Call `agent_knock_knock_status`.
2. Show the detected request details to the user.
3. Require explicit approval of that exact current request.
4. Call the exact `approve` action currently advertised by `agent_knock_knock_list`, preserving its prefilled `turn_id` or terminal `conversation_id` and any `expected_terminal_token`, and add the returned `terminal_status.approval_state.fingerprint` as `expected_approval_fingerprint`.

The equivalent slash command must also include that fresh fingerprint:

```text
/akk approve @a1b2c3d4 --expected-approval-fingerprint <fresh-fingerprint>
```

For hookless Claude Code, the callback intentionally omits the raw command. Require the user to inspect the named live terminal pane personally; never approve from a hash or summary alone. Claude manual approval accepts only the strictly recognized one-time **Yes** Bash dialog for the current managed turn. Codex approval also requires the current visible prompt. When list advertises a terminal-scoped Codex approval because managed foreground UUID attribution is unavailable, preserve its one-use terminal token exactly; the action is manual-only, leaves managed identity unchanged, and must not be retried blindly after an uncertain transport result.

Unknown, stale, expired, ambiguous, persistent-permission, replayed, or changed requests must not be approved. Deny or interrupt them with `agent_knock_knock_cancel`, or tell the user to resolve them directly in the terminal.

A trusted, default-disabled plugin `autoApprove` policy may independently approve only an exact configured agent, command vector, and canonical root listed in `autoApprove.rules[].workspaces`, backed by current terminal evidence. A rule may list multiple workspace roots. These entries are the only workspace boundary for automatic approval; they do not limit pane discovery or manual control. The model cannot create or modify that policy.

## Terminal Sessions

`agent_knock_knock_list` is terminal-first: every eligible already-running Codex or Claude Code pane appears once in `terminals[]`, even when retained managed Turns reference it. The resource chain is terminal → verified native session → managed AKK `session_id` → Turns; independent observation-only records appear in `terminal_watches[]` and are addressed only by `watch_id`. `process_state` reports process liveness and `activity_state` reports the parsed screen state. `managed.current_turn` is the authoritative active Turn for that terminal; otherwise `managed.recent_turn` shows the newest retained context. A human-driven thread mismatch remains `management_state="conflict"`; `handoff_state="external_handoff_adoptable"` authorizes only the exact fenced `send` advertised on that row, while `external_handoff_blocked` means do not send or guess a recovery. Listing itself never adopts the new context. Request `all=true` only when older `managed.history`, settled Terminal Watches, or retained unavailable history is needed. By default, `unavailable_managed_turns[]` contains attention-needed records whose terminal is unavailable.

The top-level v17 `action_contracts` summarizes each tool's strict managed target, Terminal Watch target, and terminal-scoped human-priority inputs; `available_actions` is the authoritative current-action source after listing except for the explicitly modeled nested handoff decision and `blocking_turns[].recovery_action`. Both require explicit user confirmation and a fresh list after success; the handoff decision is additionally snapshot-bound. A terminal row's `watch` action is likewise snapshot-bound: copy its exact terminal ID and binding token, then use only the returned `watch_id` for status or unwatch. When advertised, an existing managed Session's `session_exact` send targets `session_id` and starts a new managed Turn without following a replacement context in the pane. A `terminal_follow_current` current-pane send instead advertises the exact terminal `selector` and fresh `expected_terminal_token`; preserving both permits one ordinary submission followed by exact acceptance-based binding, including after a supported manual Codex `/clear`. Legacy first attach may still use a discovery selector explicitly named by the user or the exact selector prefilled by an unmanaged raw-terminal row; no selector may be passed as `session_id`. `respond` and strict managed controls target `turn_id`; terminal-scoped manual Codex approval is the only control exception and requires the exact listed `conversation_id`, terminal token, fresh status fingerprint, and explicit user confirmation. It cannot auto-approve or mutate managed identity. The read-only `list_resumable_threads` action is advertised on the terminal row, requires only its full `terminal_id`, and returns a fresh `expected_binding_token` plus candidate rows. The `new_thread` mutation is advertised on the terminal row and requires that terminal ID and token; each resumable candidate row advertises its own `resume_thread` mutation with the same snapshot token, its complete `native_thread_id`, and its opaque `candidate_token`. A conflict-only `reconcile_binding` action remains available as low-level recovery for one safely detachable exact binding; it preserves the listed Session revision, binding token, and terminal token, then CAS-detaches the old binding without adopting the live thread, sending terminal input, or creating a Turn. A top-level `previous` block, when present, is the only authority for a “previous/刚才那个” request. Number, short ID, and snapshot handle fields are human-facing navigation only; never pass them to the exact resume tool. Lifecycle discovery and mutations never create a Turn. Start with the complete listed action, supply all `missing_required` fields, and never infer or reuse selectors, identities, fingerprints, or tokens. Availability is a snapshot, so AKK revalidates it before side effects.

Before every terminal operation, AKK revalidates the expected agent PID and provider-owned terminal identity, then confirms that the process and pane working directories match. Sending new work additionally requires a verified idle prompt. Humans can attach to the same tmux or Herdr session and continue directly at any time.

Claude Code completion depends on a strictly correlated local transcript turn and fails closed for unknown schemas, background work, or ambiguous identity. Never report completion merely because the pane looks idle.

## Final User Reply

Do not replay internal terminal-monitor or callback details.

Return:

- what was delivered;
- important files or behavior changed;
- verification performed;
- remaining issues, if any; or
- the actionable failure reason.

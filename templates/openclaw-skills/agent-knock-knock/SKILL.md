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
- `/akk resume-thread <exact-terminal-id> [uuid|previous|number|@short-id]`: list candidates when the selection is omitted, or resume one exact snapshot-bound choice without creating a Turn. `previous` also accepts the human phrase `刚才那个`.
- `/akk status [turn-selector|terminal-watch-id]`: inspect one live terminal, exact managed Turn, or exact Terminal Watch.
- `/akk respond <turn-selector>: <answer>`: answer a coding-agent question inside a `waiting_for_openclaw` Turn.
- `/akk cancel <turn-selector>`: interrupt the exact Turn without closing its terminal pane.

For human-facing ordinary-send slash forms, a selector may be `codex`, `claude`, `only`, `latest`, or an `@short-ref` returned by `AKK list`. These selectors are only a resolution layer and fail closed when the target is missing or ambiguous. The v18 structured-tool contract never exposes a selector or opaque authority value: the model supplies semantic IDs only. `send({session_id,request})` is strict `session_exact`; `send({terminal_id,request})` is `terminal_follow_current`; the two targets are mutually exclusive, and both may be omitted only when AKK must prove one unique eligible pane. The only non-ordinary Send form is an exact `send({turn_id})` copied unchanged from a current `available_actions.retry_submission`; it accepts no request text or other target and requires explicit user confirmation. Native-thread actions use the full `terminal_id`, never an `@short-ref`. Other managed controls use `turn_id`; terminal-scoped approval uses `terminal_id` after explicit user confirmation. The trusted plugin/CLI derives terminal, binding, candidate, prompt, handoff, and compare-and-swap fences privately, then revalidates them under the canonical terminal and Store locks. Never ask the user or model to copy a token, fingerprint, revision, binding ID/generation, or handoff-only live native UUID from an action; `native_thread_id` is the intentional semantic UUID for resume. For every side effect, AKK must revalidate the selected agent PID and provider-owned terminal identity, confirm that the process and pane working directories match, and revalidate the relevant composer or approval prompt.

The human-priority Codex path may proceed when the pane/process and complete open-rollout candidate inventory are exact even though no single foreground UUID can be selected, including a supported manual `/clear` whose new logical thread appears before its rollout materializes. The complete exact inventory domain binds the provider terminal, PID and process birth, workspace and canonical endpoint, and every open rollout's UUID, descriptor, device, inode, canonical path, and pre-submit byte offset. A `/clear` resume hint is advisory only, never routing or acceptance authority. Under the terminal lock, AKK isolates the predecessor, creates a separate zero-UUID provisional Session and Turn, sends the real task once, and binds only the single candidate rollout that durably accepts that exact request. A rollout-backed Codex row therefore advertises `terminal_follow_current` with `terminal_id`, not `session_exact`; a cached strict Session attempt rejects before task text and never downgrades itself. Only released predecessor Turn history from a strictly earlier binding epoch is excluded from current-send authority; unresolved current-epoch state still blocks. Use only the freshly listed semantic-ID action. Until promotion commits, strict `session_id` send, `respond`, managed `approve`, `cancel`, native lifecycle, callback delivery, and `native_inspect` remain unavailable. If delivery or acceptance is uncertain, do not retry automatically. Terminal-scoped manual Codex approval likewise exposes only `terminal_id`, requires explicit confirmation, leaves managed identity unchanged, never participates in auto-approval, and must not be retried blindly after an uncertain result.

The private approval fence remains prompt-scoped. It binds the adapter-isolated exact unredacted approval region plus terminal/process identity, decision keys and label, prompt kind, working directory, reason/detail, and request or policy evidence. The whole-screen digest and redacted excerpt are diagnostic only: output outside the approval region may continue scrolling without invalidating the same reviewed prompt. After explicit user confirmation, the plugin/CLI retains a private confirmation offer and recaptures the region under lock. Any change inside the exact region—including a command or otherwise identically redacted secret—rejects and sends zero approval keys. Never expose, persist as public action data, log, infer, or reconstruct the raw prompt evidence or its opaque fingerprint.

AKK discovers eligible panes across workspaces. When more than one target matches, choose one exact listed `terminal_id` for a structured tool or a listed selector for a human slash command; never guess based on a workspace name or path.

Natural-language forms:

- `AKK: <task>`: call `agent_knock_knock_send` with `request=<task>` and neither target ID. This succeeds only when exactly one eligible idle pane exists.
- `AKK Codex: <task>`: list first, require one exact eligible Codex row, then call `agent_knock_knock_send` with that row's `terminal_id` and `request=<task>`.
- `AKK Claude: <task>`: list first, require one exact eligible Claude row, then call `agent_knock_knock_send` with that row's `terminal_id` and `request=<task>`.
- Requests to list AKK or local coding-agent work: call `agent_knock_knock_list`.
- Requests to observe work the human started directly in the Codex or Claude Code TUI: first call `agent_knock_knock_list`, then call `agent_knock_knock_watch` only from that exact active terminal row's freshly advertised `watch` action. Pass its complete `terminal_id`; AKK resolves and revalidates the current binding authority internally, so no binding token crosses the model-facing Watch boundary.
- Requests to inspect an existing Terminal Watch: call `agent_knock_knock_status` with its authoritative `watch_id`. Requests to stop observing it: call `agent_knock_knock_unwatch` with that same `watch_id`. Never substitute a Session, Turn, terminal selector, or short reference.
- Requests to continue in the current terminal context after the human may have run `/clear`, `/new`, `/resume`, or an equivalent native operation: first call `agent_knock_knock_list`, then use only that exact terminal row's advertised `send({terminal_id,request})`; do not substitute the stale `session_id`.
- Requests to recover an AKK submission reported as uncertain: refresh `agent_knock_knock_list`. Only if the current exact Turn advertises `retry_submission`, explain that AKK will revalidate the immutable original request and may either press one Enter for the exact existing draft or retransmit that original text once after structured no-Enter proof and a positively empty composer. Require explicit user confirmation, then call the prefilled `agent_knock_knock_send({turn_id})` unchanged. Never add `request`, terminal/Session IDs, timeout fields, or callback route data, and never retry it automatically.
- Requests for the coding agent's native Codex status card or Claude Status panel: first call `agent_knock_knock_list`, then call `agent_knock_knock_native_inspect({terminal_id,inspection:"status"})` only when the exact terminal row advertises it; do not substitute AKK Turn status or ordinary send.
- Requests to list resumable native threads for an exact terminal: call `agent_knock_knock_list_resumable_threads` with the terminal row's prefilled `terminal_id`.
- Explicit requests to start a new thread or clear context: call `agent_knock_knock_new_thread({terminal_id})` only from an advertised `new_thread` action.
- Explicit requests for low-level recovery of a listed binding conflict: after explicit user confirmation, call only the advertised `agent_knock_knock_reconcile_binding({terminal_id,conflicting_session_id})`. AKK derives its revision and binding fences privately, detaches the stale/conflicting binding without adopting the live thread, and requires a fresh list afterward. Do not use it in place of an advertised follow-current send.
- Explicit requests to resume prior native context: first call `agent_knock_knock_list_resumable_threads`; then call `agent_knock_knock_resume_thread({terminal_id,native_thread_id})` for one `resumable=true` candidate using its complete UUID. For “previous” / “刚才那个”, proceed only when the fresh result advertises `previous.available_actions.resume_thread`; use that exact semantic-ID action and never substitute the newest row. Human-facing numbers and short IDs are resolved privately and are never structured tool arguments.
- Requests to inspect current output or ask what a task is doing: call `agent_knock_knock_status`.
- A later ordinary request: refresh `agent_knock_knock_list` and use only the selected terminal row's advertised send. Use `send({session_id,request})` for `session_exact` or `send({terminal_id,request})` for `terminal_follow_current`; never substitute a retained Session or Turn identity.
- Requests to continue the current terminal context are ordinary terminal-scoped sends, not lifecycle actions. Use only a freshly advertised action carrying the exact `terminal_id` when a human-driven switch is present.
- An answer to a coding-agent question in a `waiting_for_openclaw` Turn: call `agent_knock_knock_respond` with its authoritative `turn_id` and `request=<answer>`.
- Requests to stop current work: call `agent_knock_knock_cancel`.

## Sessions and Turns

AKK's identity hierarchy is terminal → native Codex or Claude Code session → AKK session → Turns. `session_id` is the strict ordinary-send target for one exact native context. `terminal_id` is the deliberately different follow-current target that lets the user hand the pane's currently verified context back to AKK after a safe human-driven switch. Each accepted ordinary send creates a distinct `turn_id` without clearing the native agent context. A `turn_id` is used for history, callbacks, respond, status, approval, cancellation, renewal, callback retry, close, and the explicitly advertised submission-retry form of Send.

Use `agent_knock_knock_send` with `request` and neither `session_id` nor `terminal_id` only when the target is unspecified. AKK must resolve exactly one eligible Codex or Claude Code pane across all workspaces, attach or discover its AKK session, and verify that it is idle immediately before writing the request. If no eligible pane exists, report AKK's setup guidance; do not substitute another execution path.

On first attach, the target terminal must be explicitly named by the user; never guess which already-running pane should receive the task.

For ordinary send or an in-flight answer:

1. Reuse an AKK session only when the user's reference uniquely identifies its verified native session and terminal incarnation.
2. If no ID is supplied and more than one eligible pane may exist, call `agent_knock_knock_list`.
3. Treat `terminals[]` as the primary resource list. Its managed context exposes `session_id`; `managed.current_turn` is the only current AKK owner, while `managed.recent_turn` and `managed.history` are retained Turn history. Records in `unavailable_managed_turns[]` have no live pane in this snapshot.
4. Read the selected resource's `available_actions`. Use only an action present there, start with its prefilled semantic IDs, supply every `missing_required` field, and consult the top-level v18 `action_contracts`. The only additional action sources are a terminal row's `handoff_decision.choices.take_over_current.action` and an exact `blocking_turns[].recovery_action`: use either only after explicit user confirmation and refresh the list immediately afterward.
5. If an existing managed Session advertises send with `session_id`, call `agent_knock_knock_send({session_id,request})`; it creates a new Turn strictly in that Session's native context. If the selected row instead advertises follow-current send, call `agent_knock_knock_send({terminal_id,request})`; this action may adopt a safe human-driven handoff or send once within an exact, complete Codex rollout-candidate inventory before binding the uniquely accepting native thread. The status-card-only first-task path remains the zero-rollout special case. `send({turn_id})` is never an ordinary target: use it only for a fresh `retry_submission` action after explicit confirmation, with no other field. Never construct or pass an opaque fence. Use `respond` with its `turn_id` only when that Turn is explicitly `waiting_for_openclaw`; the answer stays in the same Turn. Do not add timeout fields for ordinary use; `timeoutSeconds` is unsupported.
6. If multiple terminals match, show their `short_ref`, agent, provider, and terminal target, then ask the user to choose. If a human switch has an unresolved Turn, ambiguous ownership, or unverifiable identity and no follow-current send is advertised, report that blocker and ask the user which context to resolve; never guess, supersede active work, or bypass the fence.

An idle pane is at a verified ready prompt, with no current work or unresolved permission request. A previously completed managed turn alone is not proof that the pane is still idle.

Do not treat ordinary send as native clear, new-session, fork, branch, side thread, status probe, or resume. Do not send `/clear`, `/new`, `/resume`, `/status`, Codex `/fork`, `/side`, `/btw`, Claude `/branch`, or any other first-line native slash command as ordinary task or answer text. Dedicated native lifecycle and inspection tools own their closed commands, capability checks, serialization, identity verification, and binding fences; express other requests in natural language or leave unsupported native commands to a human in the terminal UI. Each successful lifecycle transition creates no Turn, and native inspection creates no Session or Turn.

## Terminal Watch

Terminal Watch is only for one task that the human started directly in the live TUI. The required sequence is human starts the task in Codex or Claude Code → fresh `agent_knock_knock_list` or `/akk list` while it is working or awaiting approval → copy only that row's complete advertised `watch` action → retain the returned `watch_id` for status or unwatch. The slash form `/akk watch <exact-terminal-id>` performs its own fresh list lookup and requires that exact row to still advertise `watch`.

Never suggest or call Terminal Watch for an active AKK-managed Turn. List and status omit the Watch prompt for that Turn, and a direct Watch attempt is rejected; use its existing managed monitor, status, and callback path instead.

The Watch is an independent durable schema-v1 aggregate, not a Conversation, Session, Turn, dispatch receipt, monitor owner, or terminal-input authority. It neither sends input nor adopts, claims, reserves, blocks, interrupts, or continues the human's task. `unwatch` marks only the Watch `cancelled`; it does not press a key or stop the coding agent.

Its authority is the exact terminal endpoint and process incarnation, native thread/task, supported agent behavior profile, and privacy-safe provider anchor captured at creation. Codex binds the exact rollout file plus the current human task's request/turn byte boundaries. Claude binds the exact transcript file, root prompt, and current-turn byte boundaries. Process, endpoint, native-thread, file identity, truncation/replacement, boundary, successor-task, version, fingerprint, missing-evidence, or ambiguity drift invalidates the Watch. Never follow the pane's current task or reconstruct a new anchor.

Approval is notification-only. Show the user that the watched TUI needs attention and tell them to inspect and decide there. Never call an approve tool for a Watch, send approval keys, or apply `autoApprove`; a new exact approval fingerprint is notified once while the Watch remains active. Terminal outcomes settle once. The durable outbox uses deterministic notification IDs/idempotency and leased retry, so startup and periodic supervision can safely recover callback delivery after AKK, OpenClaw, or Gateway restart.

The current plugin registers 16 OpenClaw tools and list action-contract v18. Every structured model action carries semantic IDs only; opaque fences are derived and revalidated privately. Watch uses `agent_knock_knock_watch({terminal_id})`, `agent_knock_knock_status({watch_id})`, and `agent_knock_knock_unwatch({watch_id})`; its internal CLI boundary is `watch-terminal`, `watch-status`, `unwatch-terminal`, and `reconcile-watches`.

For native status inspection:

1. Use only a current `available_actions.native_inspect({terminal_id,inspection:"status"})` entry. Those semantic arguments are complete; never add a command or authority field.
2. Supported exact profiles are Codex 0.146.0/0.146.1/0.147.0/0.148.0 and Claude Code 2.1.218/2.1.226/2.1.237 `inspection="status"`. Claude success includes parsing and safely dismissing the newly opened Status panel. The tool does not accept `/status` text or any arbitrary command string. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and unsupported versions remain unavailable. Never automate bare Codex `/usage`: it opens an interactive menu whose later Enter can select an account-side usage-limit reset.
3. Treat this as terminal input even though the native command is read-only. AKK privately derives a fresh binding fence and requires an idle empty composer, exact PID/process/pane/cwd/version identity, and no conflicting Turn, transition, dispatch, approval, or owner.
4. Codex `/status` requires an exact viewport of at least 80 columns so the full Session UUID can be proven. That pre-UUID gate applies to native inspection, lifecycle, and strict Session operations that must know the UUID before terminal input. An otherwise eligible terminal-scoped ordinary task may send once and bind from exact native acceptance afterward, so it does not run `/status` or fail merely because the pane is narrow.
5. The result is valid only when AKK proves one fresh bounded native status result and the pane returns to idle. On an uncertain or unproven submission, do not retry, send Enter, clear the composer, or bypass AKK with raw terminal input.
6. Native inspection creates no AKK Session, Turn, receipt, monitor, callback, or response round.

For native-thread lifecycle discovery or mutation:

1. Start from the exact terminal row's currently advertised `list_resumable_threads({terminal_id})` or `new_thread({terminal_id})` action. Listing is read-only and creates no Turn.
2. Before `new_thread` or `resume_thread`, the terminal must be verified idle and have no active or unresolved Turn. The plugin/CLI derives and revalidates the current binding fence internally; the model never supplies one.
3. For resume, list candidates first and invoke only `resume_thread({terminal_id,native_thread_id})` for one row with `resumable=true`, using its complete UUID. Never select by title, preview, recency, or partial UUID. Human slash-command numbers and collision-safe short IDs refer only to the current private snapshot and are resolved inside AKK; they are never structured tool arguments. If the user says “previous” or “刚才那个”, proceed only when AKK advertises one exact previous candidate derived from the latest committed transition; if absent, explain that AKK cannot prove it and ask the user to list/select instead.
4. Treat mutation success as a Session/native-context transition, not as task delivery. It creates or activates an AKK `session_id`, advances the terminal binding generation, and creates no `turn_id`. The next ordinary send creates the first Turn in that context.
5. If the agent/version is unsupported, a candidate is ambiguous or active elsewhere, the private fence is stale, or post-transition identity cannot be verified, fail closed and report the error. Do not fall back to raw terminal commands.

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

Submission retry remains part of `agent_knock_knock_send`, not callback retry or renewal. Use its exact `{turn_id}` form only from a current advertised `retry_submission` action and only after explicit confirmation. AKK never accepts replacement text from the caller, never clears the composer, and never sends Control-C. It first checks for native acceptance and repairs state without input when possible. Otherwise it fails closed unless it can prove the exact existing draft for one Enter, or prove both that Enter was never attempted and that the live composer is positively empty before retransmitting the immutable original request once. Any terminal, identity, route, draft, modal, approval, working-state, or one-shot reservation drift sends no further input.

Use `agent_knock_knock_close` only after the user explicitly asks to close the selected AKK Turn. That explicit choice has priority over stalled, deferred-transfer, Session, ledger, handoff, callback, or receipt conflicts: Close first records the Turn as closed and releases AKK management. It never sends terminal input, interrupts or stops the coding agent, or closes the terminal pane. Cleanup of linked AKK transfer, Session, ledger, and callback metadata is best-effort; preserve stale, malformed, or newer records and report warnings instead of refusing the user's Close. A callback attempt already in flight or accepted by the host may still arrive, but Close authorizes no new callback start or retry. Refresh `agent_knock_knock_list` afterward; if the coding agent is still working, use the newly advertised Watch action to observe it again. Orphan terminal-dispatch/lifecycle recovery with `expected_message_id` or `expected_transition_id` remains a separate raw-terminal operation.

Use `/akk doctor` only for installation checks or troubleshooting.

## Terminal Approval

Approval is a sensitive action. On an unmanaged raw-terminal row, the terminal-scoped Codex approval action is prefilled with its exact `terminal_id`; never construct or guess that target.

A Terminal Watch approval callback is not an approval action. Notify the user and require them to inspect and decide in the live TUI; never continue with the steps below for a `watch_id`.

1. Call `agent_knock_knock_status`.
2. Show the detected request details to the user.
3. Require explicit approval of that exact current request.
4. Call only the current advertised managed `approve({turn_id})` or terminal-scoped `approve({terminal_id})` action. Do not add a token or fingerprint.

AKK retains a private confirmation offer, then recaptures and revalidates the exact prompt, process, pane, owner, and decision under lock immediately before one approval key. If anything changed, the action fails closed and requires a fresh review.

For hookless Claude Code, the callback intentionally omits the raw command. Require the user to inspect the named live terminal pane personally; never approve from a hash or summary alone. Claude manual approval accepts only the strictly recognized one-time **Yes** Bash dialog for the current managed turn. Codex approval also requires the current visible prompt. A terminal-scoped Codex approval is manual-only, carries `terminal_id`, leaves managed identity unchanged, and must not be retried blindly after an uncertain transport result.

Unknown, stale, expired, ambiguous, persistent-permission, replayed, or changed requests must not be approved. Deny or interrupt them with `agent_knock_knock_cancel`, or tell the user to resolve them directly in the terminal.

A trusted, default-disabled plugin `autoApprove` policy may independently approve only an exact configured agent, command vector, and canonical root listed in `autoApprove.rules[].workspaces`, backed by current terminal evidence. A rule may list multiple workspace roots. These entries are the only workspace boundary for automatic approval; they do not limit pane discovery or manual control. The model cannot create or modify that policy.

## Terminal Sessions

`agent_knock_knock_list` is terminal-first: every eligible already-running Codex or Claude Code pane appears once in `terminals[]`, even when retained managed Turns reference it. The resource chain is terminal → verified native session → managed AKK `session_id` → Turns; independent observation-only records appear in `terminal_watches[]` and are addressed only by `watch_id`. `process_state` reports process liveness and `activity_state` reports the parsed screen state. `managed.current_turn` is the authoritative active Turn for that terminal; otherwise `managed.recent_turn` shows the newest retained context. A human-driven thread mismatch remains `management_state="conflict"`; `handoff_state="external_handoff_adoptable"` authorizes only the exact fenced `send` advertised on that row, while `external_handoff_blocked` means do not send or guess a recovery. Listing itself never adopts the new context. Request `all=true` only when older `managed.history`, settled Terminal Watches, or retained unavailable history is needed. By default, `unavailable_managed_turns[]` contains attention-needed records whose terminal is unavailable.

The top-level v18 `action_contracts` summarizes each tool's semantic-ID inputs; `available_actions` is the authoritative current-action source after listing except for the explicitly modeled nested handoff decision and `blocking_turns[].recovery_action`. Approval, handoff takeover, and `reconcile_binding` require explicit user confirmation and a fresh list after success. Model-facing shapes are: `watch({terminal_id})`; `send({session_id|terminal_id,request})`, with the targets mutually exclusive; managed `approve({turn_id})` or terminal-scoped `approve({terminal_id})`; `native_inspect({terminal_id,inspection})`; `new_thread({terminal_id})`; `resume_thread({terminal_id,native_thread_id})`; and `reconcile_binding({terminal_id,conflicting_session_id})`. A top-level `previous` block, when present, is the only authority for a “previous/刚才那个” request; human-facing numbers and short IDs remain slash-navigation aids and are never structured tool arguments. The model never carries terminal, binding, candidate, handoff, approval, revision, binding ID/generation, or handoff-only live-native-UUID fences; `native_thread_id` remains the semantic resume identity. AKK derives those private fences and revalidates them under lock before side effects. Orphan-close `expected_message_id` and `expected_transition_id` remain because they are entity IDs. Store format remains 1 and writer protocol remains 5.

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

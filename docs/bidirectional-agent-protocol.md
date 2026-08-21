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
├─ native Codex or Claude Code session
│  └─ AKK session (session_id)
│     ├─ Turn (turn_id)
│     └─ Turn (turn_id)
└─ Terminal Watch schema v1 (watch_id + exact human-task anchor)
```

- The terminal is the physical pane and coding-agent process incarnation.
- The native session is the continuing context owned by Codex or Claude Code.
- The AKK `session_id` identifies the continuing context. It is an ordinary-send target only when the current listed action explicitly prefills the `session_exact` scope; a rollout-backed Codex pane instead uses the listed `terminal_follow_current` selector/token action.
- A `turn_id` identifies exactly one accepted dispatch through its final monitor and callback state.
- A `watch_id` identifies an observation-only aggregate for one task that the human started directly in the TUI. It is never a Session, Turn, dispatch receipt, or terminal owner.
- A terminal binding generation identifies one verified terminal-to-native-thread attachment. Native lifecycle transitions advance it even though they create no Turn.

Human-friendly selectors such as `only`, `codex`, `claude`, terminal IDs, and `@short-ref` are list/discovery inputs. Callers use only the exact current listed send action: either `session_exact` with `session_id`, or `terminal_follow_current` with its full selector and fresh token. A `turn_id` remains the target for managed controls. An unmanaged raw-terminal row may publish its own exact compatibility selector for status or recovery controls; callers must use only the prefilled action and never construct that selector.

## Turn Flow

1. OpenClaw calls ordinary send using the exact current listed action and the user-facing request. `session_exact` carries `session_id`; `terminal_follow_current` carries the full terminal selector and fresh snapshot token. Initial discovery may first resolve one eligible Codex or Claude Code terminal into an AKK session.
2. AKK verifies that the session is bound to the expected native session, terminal, and idle coding-agent process.
3. AKK creates a unique `turn_id`, writes the request to the verified idle pane, and starts a monitor bound to that Turn, pane, process, and message.
4. The coding agent works in the same terminal that the human can inspect or take over.
5. AKK sends a structured callback containing both `session_id` and `turn_id` to the originating OpenClaw session when it has reliable approval, completion, cancellation, stall, or failure evidence.
6. After completion, refresh the terminal list. Another ordinary send through that row's current exact action creates a new Turn without clearing the native coding-agent context.

An ordinary send never targets a completed or historical `turn_id`. If the current Turn is `waiting_for_openclaw` because the coding agent asked a question, OpenClaw uses `respond(turn_id, answer)`; that answer remains inside the same Turn.

If no eligible terminal exists, AKK stops and returns an actionable setup message. It does not launch an invisible replacement agent.

## Human-Started Terminal Watch

Terminal Watch is the observation-only path for a task already started by the human in the visible Codex or Claude Code TUI:

1. The human starts the task directly in the TUI; AKK did not submit it.
2. While the exact task is working or awaiting approval, obtain a fresh `/akk list` and use only that terminal row's advertised `available_actions.watch`. Preserve the complete `terminal_id` and `expected_binding_token`; never construct or reuse either value.
3. `agent_knock_knock_watch`, or `/akk watch <exact-terminal-id>` after its own fresh action lookup, creates one durable schema-v1 `TerminalWatch` and returns its `watch_id`.
4. Status and cancellation target only that ID: `agent_knock_knock_status({watch_id})`, `/akk status <watch-id>`, `agent_knock_knock_unwatch({watch_id})`, or `/akk unwatch <watch-id>`.
5. Startup and periodic supervision observe and settle the same Watch, then deliver its durable notification outbox to the originating OpenClaw session.

The aggregate records a revision, exact terminal endpoint and process incarnation, native thread/task identity, agent/version behavior profile, a privacy-safe provider anchor, OpenClaw route, timestamps/deadline, lifecycle status, last activity, approval fingerprint, optional settlement, and notification receipts. It lives independently from Session/Turn state. Creating, observing, querying, or cancelling it never sends terminal input; adopts, claims, reserves, or blocks a task; creates a Session or Turn; or grants callback authority to a managed Turn.

Codex anchors bind the exact rollout file identity and the human task's request/turn byte boundaries. Claude anchors bind the exact transcript file identity, root prompt, and current-turn byte boundaries. Both also bind terminal, process, native thread, workspace, and exact supported behavior profile. An exact durable completion already written to the anchored task wins; while it remains pending, a replacement, truncation, successor task, changed boundary or fingerprint, process/thread/endpoint drift, unsupported profile, missing evidence, or ambiguity produces `invalidated` rather than following whatever is currently visible.

An approval observation appends at most one notification per exact fingerprint and leaves the Watch active. It never sends approval keys and never enters automatic approval; a human must inspect and decide in the TUI. Completion, failure, timeout, invalidation, or explicit `unwatch` settles once and enqueues one terminal notification. Deterministic notification IDs and idempotency keys, append-only receipts, claim leases, and retry timestamps make callback recovery crash-safe: transport is at-least-once, while the idempotency key makes the logical notification effectively at-most-once.

The current OpenClaw surface has 16 registered tools and emits list action-contract v17. Its Watch tools map to four internal CLI entries: `watch-terminal`, `watch-status`, `unwatch-terminal`, and `reconcile-watches`. These entries are an internal adapter boundary, not alternate raw terminal controls.

## Native Thread Transitions

New/clear and resume are lifecycle transitions, not message types and not ordinary sends:

```text
verified idle terminal + current binding token
├─ new_thread ────> new native thread + new AKK Session
└─ resume_thread ─> exact historical native thread + restored/new AKK Session
                                      (no Turn created)
```

Before either transition, AKK requires the exact full `terminal_id`, a fresh compare-and-swap `expected_binding_token`, a supported adapter/version, an idle prompt, and no active or unresolved Turn. Resume additionally requires a complete native thread UUID and the selected row's opaque `candidate_token` from the same terminal's same verified candidate snapshot. Human-facing numbers, collision-safe short IDs, and opaque handles are scoped to a five-minute private runtime snapshot; resolution restores the full UUID/token tuple and revalidates the entire ordered candidate set, terminal dispatch generation, process, workspace, and binding before input. They are never stored as native identity. `previous` is derived only from the current bound Session's latest committed transition and its exact `before_native_thread_id`, and is advertised only when fresh discovery proves exactly one resumable source; static lineage and recency are not authority. The candidate token fingerprints the historical identity evidence so a replaced or changed transcript/rollout cannot be resumed under stale metadata. Candidates from another workspace, archived or ambiguous threads, and threads active in another process are not resumable.

The lifecycle operation is serialized against send, approval, monitor, cancellation, and recovery work for that pane. AKK records the previous and next native identities, verifies the post-operation identity and idle prompt, creates or reactivates the corresponding AKK Session, and advances the binding generation. It fails closed if any identity or capability evidence is missing or changed. Monitor supervision never reclassifies a historical binding: only a later lifecycle listing may classify one bound historical Session as resumable when its recorded process has conclusively exited, and the resume mutation compare-and-swap detaches that binding before terminal input. Every first-line native slash command is rejected as ordinary task or answer text, including clear/new/resume/status, Codex fork/side-thread commands, and Claude conversation branching; supported context changes must use the lifecycle boundary.

For the next ordinary send, refresh `agent_knock_knock_list` and use only the resulting terminal row's advertised action. A `session_exact` action targets the resulting `session_id`; a `terminal_follow_current` action instead preserves that row's full terminal selector and fresh token. Either accepted action creates the context's first new `turn_id`. A callback, monitor, approval, receipt, or recovery action bound to an earlier Session, native identity, terminal incarnation, or binding generation cannot mutate the newly active context.

## Native Status Inspection

`agent_knock_knock_status` is an AKK Turn/screen inspection. It does not execute a coding-agent slash command. Native inspection is a separate terminal action advertised only when the exact adapter/version, terminal identity, binding token, idle composer, and ownership state are currently safe.

The `agent_knock_knock_native_inspect` contract accepts exactly three fields: the full `terminal_id`, `inspection="status"`, and the action's fresh `expected_binding_token`. The adapter owns the closed command; callers cannot supply a command string. Native inspection supports verified Codex 0.146.0/0.146.1/0.147.0/0.148.0 and Claude Code 2.1.218/2.1.226/2.1.237 `/status` behavior profiles. Claude's modal Status panel must be freshly proven, parsed, dismissed once, and followed by the same idle empty composer. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and unsupported versions remain unavailable. Bare Codex `/usage` opens an interactive menu whose later Enter can select an account-side usage-limit reset, so it must not be treated as a read-only inspection.

Native inspection is serialized against send, lifecycle transition, approval, cancellation, monitoring terminal access, and recovery. It verifies the exact slash composer beyond the versioned Enter-suppression window, sends at most one Enter, proves one fresh bounded/redacted status result, and requires an idle postcondition. It creates no Session, Turn, dispatch receipt, monitor, callback, or response-round state. Any stale token, non-empty composer, identity/version drift, unresolved Turn/transition/dispatch, unproven Enter, or ambiguous result fails closed without a blind second Enter.

Ordinary `send` and `respond` continue to reject every first-line native slash command. Native inspection is a narrow capability boundary, not a slash-command allowlist.

## Message Types

| Type | Purpose |
| --- | --- |
| `task` | OpenClaw starts a new Turn with work for the coding agent. |
| `answer` | OpenClaw answers a question inside a `waiting_for_openclaw` Turn. |
| `progress` | AKK reports reliable non-final progress. |
| `blocked` | AKK reports that the task needs attention. |
| `done` | AKK reports that the current terminal turn completed. |
| `error` | AKK reports a terminal, monitor, callback, or protocol failure. |
| `control` | AKK records Turn-level control such as cancellation or timeout. |

The coding agent does not run a callback command and does not need an AKK-specific hook or plugin. AKK's terminal monitor owns callback delivery.

## Terminal Identity

Each managed Turn is bound to a concrete identity, including:

- coding agent (`codex` or `claude`)
- canonical working directory captured for this pane and Turn
- tmux socket and pane target
- pane and agent process identity
- native session evidence, AKK `session_id`, `turn_id`, and message identity
- terminal binding ID and generation, including the transition that established it
- monitor owner and lease

AKK revalidates that identity before sending tasks, interrupt keys, or approval input. Stale, changed, ambiguous, or replayed actions are rejected.

Approval authorization is prompt-scoped. An adapter must isolate one complete bounded approval region and keep its exact unredacted bytes local; AKK fingerprints that region with the terminal/process identity, one-time decision, prompt kind, working directory, reason/detail, and request evidence. The whole terminal capture digest and redacted excerpt are diagnostic only. Output outside the prompt may continue scrolling across authorization and dispatch reservation without invalidating the reviewed approval, while any prompt-region, option/highlight, command/secret, kind, process, cwd, reason, or request-evidence change fails closed before an approval key is sent. Missing or ambiguous prompt-region evidence is never downgraded to whole-screen or parsed-display authority. Pre-v16 whole-screen fingerprints and approval tokens that embed them are stale and require fresh `list`/`status` evidence.

The OpenClaw plugin supervises eligible terminal monitors and Terminal Watches
independently of interactive commands. At startup and in one non-overlapping
five-second cycle, it runs managed-Turn monitor reconciliation and Terminal
Watch reconciliation as separate coordination steps with separate error
boundaries; a failure in either step does not starve the other. Managed monitor
reconciliation distinguishes a transient Store-lock timeout from proven binding
supersession and preserves the Turn's exactly-once completion claim across
monitor replacement. Watch reconciliation restores observation and retries its
durable idempotent callback outbox. Codex managed completion first scans the
exact accepted native turn in the rollout bound to the Turn; it does not fall
back to another same-workspace rollout after that exact detector reports an
identity or integrity failure. Detector limitations are retained in the Turn
event history for diagnosis.

## Human Handoff

The tmux pane remains the source of visible truth:

- Attach to tmux to inspect or continue the work yourself.
- Use AKK status for a bounded remote view.
- Send the next request to `session_id` only when AKK verifies the pane is idle; this creates a new Turn.
- Answer an in-flight agent question only through `respond(turn_id, answer)`.
- Interrupt the current turn without closing the pane.
- Renew monitoring only when the same live task remains in that pane.

This makes handoff reversible: OpenClaw and the human operate the same coding-agent session instead of creating parallel, hidden conversations.

Native clear/new/resume operations are separate Session-lifecycle features. Ordinary send and Turn creation do not invoke them; successful lifecycle transitions create no Turn.

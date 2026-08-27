# Terminal Handoff Protocol

Agent Knock Knock coordinates OpenClaw, a local coding agent, and a human through one visible tmux terminal.

- OpenClaw is the orchestrator, requirements owner, and final acceptance decision maker.
- Codex or Claude Code performs the engineering work inside tmux.
- AKK owns terminal delivery, monitoring, lifecycle state, and callbacks.
- A human can attach to the same tmux pane at any time, continue directly, and later hand control back to OpenClaw.
- AKK sends input only after it verifies the selected agent, pane, process, pane/process working directory, approval state, and action-specific composer. Managed paths require idle; an advertised user-explicit physical Send may steer a working mutable composer.
- AKK labels the evidence behind every notification. Managed Turns and exact-task Watches report completion only from correlated evidence; a user-selected terminal-activity Watch may instead report a clearly marked best-effort stable-idle observation that is not exact task-completion proof.

## Identity Model

AKK models shared work as:

```text
tmux terminal / verified process incarnation
├─ native Codex or Claude Code session
│  └─ AKK session (session_id)
│     ├─ Turn (turn_id)
│     └─ Turn (turn_id)
└─ Terminal Watch schema v2 (watch_id + exact task anchor or terminal-activity epoch)
```

- The terminal is the physical pane and coding-agent process incarnation.
- The native session is the continuing context owned by Codex or Claude Code.
- The AKK `session_id` identifies a continuing context and is the strict `session_exact` send target. The physical `terminal_id` is the separate `terminal_follow_current` or user-priority `terminal_user_explicit` send target, exactly as advertised.
- A `turn_id` identifies exactly one accepted dispatch through its final monitor and callback state.
- A `watch_id` identifies an observation-only aggregate for a user-selected exact terminal. It prefers one provider-correlated task, may fall back to that terminal/process activity epoch, and may also identify one exact request already delivered through user-explicit unmanaged fallback. It is never a Session, Turn, dispatch receipt, terminal owner, or terminal-input authority.
- A terminal binding generation identifies one verified terminal-to-native-thread attachment. Native lifecycle transitions advance it even though they create no Turn.

Human-friendly selectors such as `only`, `codex`, `claude`, and `@short-ref` remain slash-command discovery inputs. The v23 structured model contract carries semantic IDs only and does not expose selectors or opaque authority values. Its core shapes are `send({session_id|terminal_id,request})` with mutually exclusive targets, `watch({terminal_id})`, `native_inspect({terminal_id,inspection})`, `new_thread({terminal_id})`, `resume_thread({terminal_id,native_thread_id})`, managed `approve({turn_id})` or terminal-scoped `approve({terminal_id})`, and `reconcile_binding({terminal_id,conflicting_session_id})`. Approval, handoff takeover, and reconciliation require explicit user confirmation. The trusted plugin/CLI privately derives and revalidates terminal, binding, candidate, prompt, composer, handoff, revision, and compare-and-swap fences; the model never transports them. Store format remains 1 and writer protocol remains 6.

## Turn Flow

1. OpenClaw calls ordinary send using the exact current listed action and the user-facing request. `session_exact` carries `session_id`; `terminal_follow_current` and `terminal_user_explicit` carry `terminal_id`. Both target fields may be omitted only when AKK must prove one unique send-ready pane. Initial discovery may first resolve one eligible Codex or Claude Code terminal into an AKK session.
2. AKK verifies that the session is bound to the expected native session, terminal, and idle coding-agent process.
3. AKK creates a unique `turn_id`, writes the request to the verified idle pane, and starts a monitor bound to that Turn, pane, process, and message.
4. The coding agent works in the same terminal that the human can inspect or take over.
5. AKK sends a structured callback containing both `session_id` and `turn_id` to the originating OpenClaw session when it has reliable approval, completion, cancellation, stall, or failure evidence.
6. After completion, refresh the terminal list. Another ordinary send through that row's current exact action creates a new Turn without clearing the native coding-agent context.

Steps 2–6 describe managed delivery, which may require an exact empty Composer before input. For an advertised `terminal_user_explicit` Send, AKK first attempts that managed path where it is eligible. If AKK's Store, Turn, Session, deferred-transfer, transition, ledger, or managed pre-input Composer authority prevents it before terminal input, the user's physical-terminal authority takes over. Codex physical fallback requires the exact live terminal/process plus a scanned, non-blocked approval state, but not Composer visibility, stability, or exactness. It sends `C-u` once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once. After text injection, neither the managed path nor fallback may use Composer observation to veto Enter. Claude Code remains exact-empty-only. Before mutation, AKK best-effort captures the exact provider byte boundary; after Enter succeeds, it best-effort persists a request-hash-bound Terminal Watch. The unmanaged path creates no managed callback Turn, but the Watch supplies a product-equivalent completion callback. Watch failure is reported without changing or retrying the successful Send. Once the sole Codex mutation sequence begins, an uncertain result must not be retried automatically; `watch-status` is the recovery path.

An ordinary send never targets a completed or historical `turn_id`. If the current Turn is `waiting_for_openclaw` because the coding agent asked a question, OpenClaw uses `respond(turn_id, answer)`; that answer remains inside the same Turn.

If no eligible terminal exists, AKK stops and returns an actionable setup message. It does not launch an invisible replacement agent.

### Trusted controller callback boundary

Callback routing is an administrator/trusted-host concern, never a model
argument. The OpenClaw plugin captures its own authenticated controller
session identity and gives AKK a versioned, secretless `callback_route`; the
durable outbox freezes that route together with a canonical callback envelope
before delivery. A transport returns one explicit outcome: accepted,
retryable failure, permanent failure, or uncertain. Permanent and uncertain
outcomes are not blindly retried, while an accepted checkpoint remains
authoritative if a later wake or observation step fails.

The phase-one implementation still ships only the OpenClaw transport and keeps
the existing OpenClaw Store fields readable and dual-written for compatibility.
The core outbox, managed-Turn monitor, stall notification, and Terminal Watch
use the host-neutral route/envelope/outcome boundary; OpenClaw-specific
`sessionKey`, Gateway calls, executable paths, and credentials remain inside
the trusted OpenClaw adapter. No route, profile, controller-session identity,
token, composer digest, draft text, or transport evidence is exposed through the v23 model-facing contract.
This boundary alone does not provide a standalone supervisor or enable another
controller host; those require their own trusted session-context adapter and
runtime integration.

## User-Selected Terminal Watch

Terminal Watch is the read-only, user-intent-first path for observing an exact visible Codex or Claude Code terminal:

1. The user selects one complete `terminal_id`. A fresh `/akk list` and its advertised `available_actions.watch` are the safest discovery path, but advertisement is not authorization and its absence does not veto an explicit Watch request.
2. `agent_knock_knock_watch({terminal_id})`, or `/akk watch <exact-terminal-id>`, observes that exact endpoint/process and attempts to construct one privacy-safe exact task anchor. It does not acquire terminal-input or managed-owner authority.
3. If a unique provider task anchor is available, AKK creates `watch_mode="exact_task"`, `confidence="exact"`; missing or mismatched version evidence remains a warning and does not weaken that otherwise exact anchor. If task artifacts, native identity, or task boundaries cannot establish an anchor, AKK records warnings and creates `watch_mode="terminal_activity"`, `confidence="best_effort"` instead.
4. Status and cancellation target only the returned ID: `agent_knock_knock_status({watch_id})`, `/akk status <watch-id>`, `agent_knock_knock_unwatch({watch_id})`, or `/akk unwatch <watch-id>`.
5. Startup and periodic supervision observe and settle the same Watch, then deliver its durable notification outbox to the originating controller session.

Creating a Watch hard-fails only when the exact terminal is absent, its endpoint/process cannot be identified, neither a durable exact-task anchor nor a read-only screen-status activity path exists, or AKK cannot create/write the durable Watch Store. A missing or mismatched coding-agent version, unusable rollout/transcript artifact when screen activity remains observable, existing managed Turn or other ownership record, missing binding metadata, and missing `available_actions.watch` are diagnostics, never Watch vetoes. If the same exact active Watch already exists, AKK may return it rather than treating the request as a conflict. Because Watch is read-only, it can coexist with a managed monitor without adopting, superseding, or changing its Session/Turn; the managed monitor remains preferable when the user wants exact Turn attribution.

Every aggregate records a revision, exact terminal endpoint/process epoch, workspace, creation warnings, controller route, timestamps/deadline, lifecycle status, last activity, optional settlement, and an append-only notification outbox. An exact-task Watch additionally stores one privacy-safe provider anchor: Codex binds rollout identity and task request/turn byte boundaries; Claude binds transcript identity, root prompt, and current-turn byte boundaries. Exact durable completion already written to that anchor wins, while later replacement, truncation, successor task, changed boundary or fingerprint, or process/thread/endpoint drift invalidates that exact Watch instead of following a different task.

A terminal-activity Watch makes no task-identity claim. Its checkpoint must first observe activity (`working` or `awaiting_approval`) in the selected terminal/process epoch and then observe stable `idle` across consecutive reconciliation sweeps. That transition emits a completion-shaped callback with reason `terminal_activity_became_stably_idle`, but the callback and public status remain labeled `best_effort`: they prove only that observed terminal activity became idle, not that a particular task completed or succeeded. They carry no exact-task completion text. Starting from idle or unknown does not immediately settle; later activity must be seen first.

An approval observation appends at most one notification per exact fingerprint and leaves either Watch mode active. It never sends approval keys and never enters automatic approval; a human must inspect and decide in the TUI. Exact-task completion/failure, best-effort stable idle, timeout, invalidation, or explicit `unwatch` settles once and enqueues one terminal notification. Deterministic notification IDs and idempotency keys, append-only receipts, claim leases, and retry timestamps make callback recovery crash-safe: transport is at-least-once, while the idempotency key makes the logical notification effectively at-most-once.

The current OpenClaw surface has 16 registered tools and emits list action-contract v23. Its Watch tools map to four internal CLI entries: `watch-terminal`, `watch-status`, `unwatch-terminal`, and `reconcile-watches`. These entries are an internal adapter boundary, not alternate raw terminal controls. The v23 Send shape remains `send({session_id|terminal_id,request})`; the Codex composer policy is advertised as `replace_current_composer_and_submit`, not as another model-supplied argument.

## Native Thread Transitions

New/clear and resume are lifecycle transitions, not message types and not ordinary sends:

```text
verified idle terminal + private current-binding fence
├─ new_thread ────> new native thread + new AKK Session
└─ resume_thread ─> exact historical native thread + restored/new AKK Session
                                      (no Turn created)
```

Before either transition, the public action supplies the exact full `terminal_id`; resume additionally supplies the complete `native_thread_id`. AKK then derives a fresh compare-and-swap binding fence and candidate fence privately, and requires a recognized adapter, a complete `x.y.z` agent version, an idle prompt, and no active or unresolved Turn. An exact regression-tested profile is a verification level, not an authorization gate; an unverified version remains callable and carries a compatibility warning. Human-facing numbers and collision-safe short IDs are scoped to a five-minute private runtime snapshot; AKK resolves them to the complete UUID before the structured action and revalidates the entire ordered candidate set, terminal dispatch generation, process, workspace, and binding before input. They are never model arguments or stored as native identity. A replaced or changed transcript/rollout cannot be resumed under stale metadata. `previous` is derived only from the current bound Session's latest committed transition and is advertised only when fresh discovery proves exactly one resumable source; static lineage and recency are not authority. Candidates from another workspace, archived or ambiguous threads, and threads active in another process are not resumable.

The lifecycle operation is serialized against send, approval, monitor, cancellation, and recovery work for that pane. AKK records the previous and next native identities, verifies the post-operation identity and idle prompt, creates or reactivates the corresponding AKK Session, and advances the binding generation. It fails closed if any identity or capability evidence is missing or changed. Monitor supervision never reclassifies a historical binding: only a later lifecycle listing may classify one bound historical Session as resumable when its recorded process has conclusively exited, and the resume mutation compare-and-swap detaches that binding before terminal input. Every first-line native slash command is rejected as ordinary task or answer text, including clear/new/resume/status, Codex fork/side-thread commands, and Claude conversation branching; supported context changes must use the lifecycle boundary.

For the next ordinary send, refresh `agent_knock_knock_list` and use only the resulting terminal row's advertised action. A `session_exact` action supplies `session_id`; a `terminal_follow_current` action supplies `terminal_id`. Either accepted action creates the context's first new `turn_id`. A callback, monitor, approval, receipt, or recovery action bound to an earlier Session, native identity, terminal incarnation, or binding generation cannot mutate the newly active context.

## Native Status Inspection

`agent_knock_knock_status` is an AKK Turn/screen inspection. It does not execute a coding-agent slash command. Native inspection is a separate terminal action advertised when the adapter, terminal identity, private binding fence, idle composer, and ownership state are currently safe. An unverified semantic agent version adds a warning but does not hide the action.

The `agent_knock_knock_native_inspect` contract accepts exactly two fields: the full `terminal_id` and `inspection="status"`. The adapter owns the closed command, and AKK derives the fresh binding fence internally; callers cannot supply a command string or opaque authority. Regression-tested profiles cover Codex 0.146.0/0.146.1/0.147.0/0.148.0/0.149.1 and Claude Code 2.1.218/2.1.226/2.1.237. Other complete `x.y.z` versions use the generic runtime profile with a compatibility warning; unchanged UI behavior succeeds, while incompatible behavior fails or is reported uncertain without automatic retry. Claude's modal Status panel must be freshly proven, parsed, dismissed once, and followed by the same idle empty composer. `/usage`, `/cost`, `/stats`, `/usage-credits`, `/model`, `/compact`, and arbitrary slash commands remain unavailable. Bare Codex `/usage` opens an interactive menu whose later Enter can select an account-side usage-limit reset, so it must not be treated as a read-only inspection.

Native inspection is serialized against send, lifecycle transition, approval, cancellation, monitoring terminal access, and recovery. It verifies the exact slash composer beyond the versioned Enter-suppression window, sends at most one Enter, proves one fresh bounded/redacted status result, and requires an idle postcondition. It creates no Session, Turn, dispatch receipt, monitor, callback, or response-round state. Any stale private fence, non-empty composer, identity/version drift, unresolved Turn/transition/dispatch, unproven Enter, or ambiguous result fails closed without a blind second Enter.

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

Approval authorization is prompt-scoped. Managed approval carries only `turn_id`; terminal-scoped approval carries only `terminal_id`, and both require explicit user confirmation. An adapter isolates one complete bounded approval region and keeps its exact unredacted bytes and fingerprint local. The plugin/CLI retains the private confirmation offer, recaptures it under lock, and rejects before an approval key if any prompt, choice, command/secret, process, cwd, owner, or request evidence changed. Missing or ambiguous prompt evidence is never downgraded to whole-screen or parsed-display authority. No prompt fingerprint or terminal token crosses the model-facing boundary.

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

If a human context switch conflicts with an active Turn, AKK presents a decision rather than redirecting automatically. After explicit takeover confirmation, the model calls `agent_knock_knock_close({turn_id,reason:"superseded_by_human_context_switch"})`; the plugin/CLI privately resolves and revalidates the exact advertised handoff decision, so no live native UUID or handoff token is transported. Low-level binding repair is similarly explicit: `reconcile_binding({terminal_id,conflicting_session_id})` carries no Session revision, binding ID/generation, or token. Reconciliation only detaches the proven stale binding; it neither adopts the live thread nor sends terminal input.

Native clear/new/resume operations are separate Session-lifecycle features. Ordinary send and Turn creation do not invoke them; successful lifecycle transitions create no Turn.

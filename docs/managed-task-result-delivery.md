# Managed task results and delivery

An accepted managed task owes its original controller a result: the agent's
completed reply, a failure, or an explicit notice that AKK cannot currently
confirm the result. A background build is not, by itself, proof that the agent
is still composing its reply. Users continue using AKK Send and callbacks;
terminal injection is not a recovery step.

## Completion and subsequent messages

For Claude terminal Turns, AKK still requires the exact process incarnation,
session, transcript anchor, matching submitted prompt and linked record chain.
An `end_turn` reply followed by its `turn_duration` can complete that foreground
Turn while the registry reports `shell`. A Bash tool result acknowledging a
background launch, including a timeout that moved the build into the background,
does not veto that evidence. Outstanding tool calls, disconnected chains,
blocking stop hooks, ambiguous subagents/workflows and identity changes still
fail closed. Completion means the foreground reply ended, not that every
background command succeeded or every business acceptance check passed.

A subsequent Send in `shell` state additionally verifies that the **latest**
root prompt completed before capturing the new transcript boundary. A historical
completion cannot authorize sending over newer unfinished work. Truly busy or
unverifiable sessions receive an actionable refusal before any task text is sent.
Respond remains the operation for an outstanding AKK question, not a substitute
for Send. Existing Turn ownership and dispatch locks remain enforced.

## Detection failures

An observed completion-detector limitation prepares a nonblocking notification
in the existing durable advisory outbox. Its marker and payload are saved before
transport. The same continuous degraded episode does not produce a notice on
every poll, even if its diagnostic text changes. If the advisory lane is occupied,
preparation is retried on later polls without overwriting the pending notice.

Monitoring continues when delivery of that notice fails. Once detection recovers,
the ordinary completion path saves and sends the final result. A final result
supersedes an unaccepted obsolete advisory; accepted notification evidence is
retained. An accepted uncertainty notice does not count as a timeout notice.
Configured inactivity and hard-lifetime limits still apply: reaching a limit
produces the existing stalled notification and ends active monitoring. This
change does not promise automatic final detection after that explicit timeout,
Close, or loss of the original session identity.

## Durable delivery

Managed callback outboxes with a persisted route retry retryable transport
failures without exhausting the old four-delay retry budget. Backoff follows
the existing schedule and stays at its last delay (normally 60 seconds).
Startup reconciliation can relaunch a lost retry worker. Every attempt retains
the original task, notification, destination, payload and idempotency key.
An attempt is not delivery: the stored delivery becomes `delivered` only after
accepted transport evidence. Explicit Close and supersession still fence retries.

Replaying an unknown transport outcome requires a trusted Host Profile declaring
`callback.idempotentDelivery: true`, projected into the immutable route as
`capabilities.idempotent_delivery: true`. A live attempt's lease is still honored.
The current profile or authorized historical recovery route must authorize that
capability; model-provided metadata cannot grant it.

The DSH connector declares it only when durable callback recovery is available.
It reuses its existing receiver ledger: reserve a stable message ID, admit to
the original controller, flush the session, then persist acceptance. After a
restart, an accepted receipt or exact own-session message proves admission and
prevents reinjection. An unreadable inventory does not prove absence.

Older routes and Hosts without that guarantee retain the conservative unknown
outcome behavior. Permanent refusal, revoked authority, corrupt storage, an
unreadable controller inventory, or a permanently offline Host cannot honestly
be called delivered. The outbox retains its failure/uncertain evidence for Status
and recovery. This is at-least-once transport with receiver deduplication where
supported, not a claim that the human read the message. It does not migrate
existing private Store records or automatically replay an old uncertain route.

## Validation scope

Fast regressions cover foreground completion with explicit background Bash and
timeout-backgrounded builds, rejection before completion and after a newer prompt,
advisory persistence/deduplication, detection recovery, prolonged offline retries,
restart after an unacknowledged transport start, stable callback identities,
live-lease and route-capability fences. Existing DSH receiver tests cover durable
flush, accepted receipt recovery, absent-message recovery and deduplication.

These are isolated component tests. Installing the reviewed build, restarting
DSH and repeating the original live Claude task are separate authorized steps.
Full/integration tests remain the publication gate under repository policy.

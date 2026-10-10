# Backend task recovery

AKK 0.14.0 introduces exact-task recovery for its backend adapters. See the
[README](../README.md) for installation and the first-task workflow.

Codex CLI direct connections and Codex Desktop use persisted exact task identities
for recovery. These operations do not require tmux or Herdr and do not send task
text, slash commands, approvals, cancellation, or lifecycle commands to Codex.

## Management and observation

A backend Send creates a managed task with automatic observation. Its response
includes `turn_id` and `watch_id` identifying that same stored record. A standalone
Watch observes an existing task and does not acquire Send management. Inspect
`task_kind`, `management_state`, and `observation_state` separately.

| Operation | Meaning |
| --- | --- |
| `unwatch({watch_id})` | Stop observation and withdraw notifications not yet dispatched. A managed Send stays managed. |
| `close({turn_id})` | Close a managed Send, stop observation, and release its AKK management. A standalone Watch must use Unwatch. |
| `renew({watch_id, minutes})` | Verify the original task and extend observation; an expired or explicitly stopped Watch can resume while that same task is still active. |
| `recover({watch_id})` | Reconnect/read the original task, reconcile its receipt and state, and supervise eligible monitor work. Does not extend the deadline or resume an explicitly stopped Watch. |
| `retry_callback({watch_id, notification_id})` | Retry one persisted notification with its original event ID and controller target. Does not rerun the task. |

The tool prefix is `agent_knock_knock_`. Native Send `turn_id` is also accepted
by Recover, Renew, Close, Retry Callback, and Status. Unwatch uses `watch_id`.
Copy the exact IDs and available actions
from Send, List or Status. A conversation ID alone cannot select a task to close,
renew, recover, or retry. Multiple eligible failed notifications require an
explicit `notification_id`.

Starting in AKK 0.14.1, backend Renew with no explicit
`minutes` uses the Host's `agentHardTimeoutMinutes`, then the shared 720-minute
default. It sets the deadline to the later of the saved deadline and now plus
that duration; it does not add the duration to the old deadline. Terminal managed
Renew still refreshes its inactivity window (default 60 minutes) and cannot
exceed its original hard lifetime. Recover does not renew either deadline.
An upgrade alone never extends saved deadlines, revives expired observation or
replays accepted notifications.

Closed management cannot be reopened. Unwatch does not release an unresolved
Send reservation; Close explicitly releases management without asserting that
the native submission failed. Reusing the original Send message ID still returns
its original record and never resends its text. None of these operations cancels
the actual Codex task or closes its conversation.

## Identity and outcomes

Close and Unwatch update the saved AKK record and do not require reconnecting
to Codex. Recover and Renew read the original native task. Retry Callback reuses
the saved notification; an interaction notification additionally requires fresh
confirmation that its original question or approval is still pending. These
different checks do not rediscover or select another task.

Recovery uses the saved Codex home, thread, native turn, original submission
receipt and client message identity. It never substitutes the latest task, a
matching project directory, or another terminal. If the original task cannot be
verified, it remains unknown rather than being rebound. Renewal requires exact
task evidence; if that task has already settled, its actual outcome is recorded
instead of declaring it running. Each new observation deadline has its own
timeout notification generation; old unsent expiry notices are withdrawn.

Manual callback retry accepts only a recorded `retryable_failure`, including a
failure whose automatic attempts were exhausted. It preserves the notification
body, destination, event ID and cumulative attempt history. It cannot replay an
accepted notification, an in-flight attempt, an uncertain result, or a withdrawn
or obsolete interaction. Interaction notifications require fresh evidence that
the same question or approval is still pending. A closed or unwatched record
cannot dispatch callbacks. Already in-flight notifications cannot be recalled;
their eventual acknowledgement remains visible.

Callback acceptance means that the controller accepted the notification. It
does not prove that a downstream channel, such as WeChat, delivered a user-visible
message. Retry Callback is not a repair for a controller-to-channel failure.

## Terminal recovery remains separate

Existing terminal `reconcile_binding`, `identify_foreground`, and
`repair_model_control` repair or inspect a physical terminal binding or menu.
They retain their terminal requirements. Backend `recover` reconciles an exact
stored task; it does not detach a terminal binding or manufacture new authority.
Native conversation creation, clearing, restoration, model controls, and
cancellation retain their separately documented provider capabilities.

## Validation boundary

The backend recovery paths are covered by the fast regression tier, including
ownership, exact task retention, expired/stopped observation, duplicate and
uncertain sends, callback leases and retry identity. This change does not itself
establish a new live Desktop/CLI or user-visible channel delivery result. Existing
user sessions and historical notifications must not be used as implicit tests.

Development validation on 2026-10-10: `npm run test:fast` passed all 2,788 tests
and its build/Skill synchronization gates. `npm run validate:architecture` and
`npm run validate:refactor-evidence` also passed. Full, integration and release
tiers were not run during that development check, in accordance with the
repository test policy. This records development evidence, not the separate
publication gate.

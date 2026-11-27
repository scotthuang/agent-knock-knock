# Codex Desktop build 29513 and the native message queue

The November 21, 2026 investigation used macOS Desktop `26.1117.31558` (build `29513`), Codex CLI `0.171.0` and one dedicated test conversation. The production OpenClaw plugin was AKK `0.16.21`.

## What ran on the Mac

1. The test conversation appeared in AKK's project sidebar view. The legacy Desktop socket refused the connection before the owner handshake, including after the user reopened the app. The embedded app-server owned the thread's writer lock. Its PID and parent chain differed from the shared app-server reading the same local thread.
2. A standalone `codex queue --remote <shared-socket> --thread <test-thread>` invocation submitted one no-tools fixed-reply request. No `resume` was used. The queue receipt ID differed from the user item ID, client message ID and turn ID. The exact reply and terminal turn subsequently appeared in that thread. Desktop's own log recorded `received turn-complete` for the same thread and turn. That invocation created no AKK Watch or controller notification.
3. During execution, the shared history reader briefly returned `interrupted` with no completion time. The same turn later returned `completed` with a completion time. A monitor that settles on the first enum would deliver the wrong result.

## What the upstream contract guarantees

* Producers can provide a `clientUserMessageId`. The queue receipt echoes it and the executing turn's user message retains it. Correlation can therefore handle another person sending the same text. Queue edits and steering require additional checks before attributing a whole turn's result. [Client-ID propagation test](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L450-L485)
* Queue entries belong to the thread. A native test shuts down the first server, resumes the same UUID on a second server and consumes a previously queued submission. The add request carries no expected Desktop owner, generation or expiry. Checking which process holds the lock at submission cannot constrain a subsequent consumer. [Queue handler](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server/src/request_processors/thread_queue_processor.rs#L79-L102) · [Cold-resume regression](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L733-L781)
* An approval waiting on the current turn permits adding to the queue. The owning runtime rejects a request to start the queued message immediately. Empty queue, historical completion and successful enqueue each measure a different condition. [Blocked-turn regression](https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server/tests/suite/v2/thread_queue.rs#L805-L829)

The legacy owner IPC, when available, still supplies its own live interaction and write guards. With only the shared history reader, renderer drafts, open editors, active prompts and future execution ownership require separate evidence. Approval, questionnaire, model, permission and lifecycle controls were not exercised on this build.

## Candidate Status and correlation checks

The candidate CLI's ordinary `status --conversation <dedicated-selector> --store-dir <empty-test-store> --json` command read the original turn through the shared backend. The result below includes only the fields relevant to the check. The live interaction count and the durable turn status have different sources.

```json
{
  "activity_state": "unknown",
  "pending_interaction_count": null,
  "capabilities": { "send": false, "watch": false, "approve": false },
  "persisted_history": {
    "source": "codex_app_server",
    "scope": "latest_persisted_turn",
    "latest_turn": { "status": "completed" }
  }
}
```

Two independent reads verified the same Desktop writer and shared endpoint. A retrospective check used the client ID from the earlier native task's user item and the baseline captured before that task. It matched that exact completed turn. Substituting a different client ID and keeping the input identical returned `pending`. The native reply had a presentation directive, so the candidate withheld its body. Neither check submitted a new task or delivered a callback. These two checks predate the production Send acceptance below.

## AKK Send and isolated controller callback

At 14:33 local time on November 21 the candidate's semantic Host Bridge accepted a Send for the original dedicated thread. The exact queue receipt and task receipt below came from successive calls. Variable identifiers have been replaced with labels.

| Time | Observation |
| --- | --- |
| 14:33:30 | Semantic Status verified the local thread, catalog cwd and Desktop queue owner, found a completed history baseline and offered queue Send. Approval was unavailable. |
| 14:33:35 | Send returned queue ID Q, Watch W, `delivery_receipt=native_queue_accepted`, `native_turn_id=null`, `agent_acceptance=unproven` and `callback_expected=true`. |
| 14:33:48 | Status for W returned the same Q, a distinct turn T, `status=completed`, `delivery_receipt=native_task_verified` and `agent_acceptance=proven`. Desktop logged completion for the same thread and T. |
| After settlement | The isolated command-JSON controller recorded one delivery and acknowledged its exact message and delivery IDs. The Watch stored one accepted attempt. |

A single fixed-reply, no-tools task was sent. The native presentation directive withheld the final message body from the controller. The callback correctly reported settlement without disclosing the protected text. This real test used the candidate Host Bridge, a separate AKK Store and a local callback receiver. It did not install the candidate in the production Gateway or test a messaging channel.

### Operating limits of the 0.16.22 build tested above

See [current queue behavior](../codex-desktop-compatibility.md#sending-to-a-thread-with-a-queue) for the revised admission policy.

* The submit-time checks require a local Desktop writer, a completed previous turn, an empty native queue and an identifiable owner-scoped persisted draft bank without a saved draft or retained editor for this conversation. The native operation appends a message under the thread UUID. It neither types into the composer nor starts or resumes any client. Unpersisted typing and active modal state are not observable through this route. New, empty or unverifiable threads do not qualify.
* Manually resuming the same thread elsewhere before consumption can change which client executes queued work. AKK re-observes that original thread and attributes a result only to an unchanged, unique original client message in a new turn. A missing acknowledgement leaves the result uncertain until that evidence appears. Steered turns and incomplete history cannot establish attribution. Recovery observes the original submission without sending again.
* Automation and fixtures cover identical human text, changed and reordered pages, draft and endpoint changes, uncertain dispatch and callback recovery. Busy-user races and cross-client takeover were not induced in the live Desktop. The Codex upstream cold-resume test documents the latter's native behavior. Approval, question response, model/permission controls and cancellation retain their separate original-owner IPC checks.

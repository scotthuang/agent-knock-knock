# Codex CLI 0.159.0 compatibility

This release candidate extends the existing [0.158.0 adapter](codex-0.158.0-compatibility.md)
to `codex-cli 0.159.0`. The official source target is
[`rust-v0.159.0`](https://github.com/openai/codex/tree/rust-v0.159.0), commit
`687a119f0fcaace47e1f1abcc77cec6c813fd6da`.
The protocol delta has been reviewed against that tag and terminal surfaces
have been captured from the installed binary. Runtime regression and release
validation are still in progress; this document does not yet claim a successful
0.159.0 native task run.

## Source delta from 0.158.0

The paginated history protocol extends `thread/items/list.cursor` to accept an
item anchor object (`{type: "item", itemId}`) as well as the existing string
cursor. The server continues to pass the old string cursor through unchanged,
so AKK can retain its existing pagination path. See the official tag's
[`v2/thread.rs`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
and
[`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/app-server/src/request_processors/thread_processor.rs).

The reviewed turn/item schemas, native blocking and async question shapes,
expected-turn steering contract, and TUI app-server session integration have no
changes between the two tags. The exact unmaterialized-thread error used before
a first task is preserved. The daemon transport implementation is unchanged.

An interrupted turn may now include optional error details. AKK's reader already
accepts an error object. The new instant-interrupt code path can affect event
ordering while steering an active turn; source compatibility alone does not
prove the native async answer and completion sequence. The publication probe
must verify that sequence on the installed version.

## Adapter contract

The intended 0.159.0 contract is the same exact-task path used for 0.158.0:

- A fresh, closed `/status` transaction binds the chosen physical terminal and
  process incarnation to its foreground native thread.
- The local app-server's version and Codex home are checked before reading
  `thread/read`, `thread/turns/list`, and `thread/items/list`.
- Ordinary physical Send binds one exact accepted native turn. A manual Watch
  binds the current active native turn; an unrelated later task cannot take over.
- Async answers use the native question identity and expected-turn comparison;
  blocking answers use the exact pending native request. A durable native receipt
  must confirm the answer. Uncertain submission is never automatically replayed.
- Completion callbacks preserve final agent text and native Plan output and use
  the existing durable outbox for retries and duplicate suppression.

## Terminal profile changes

The installed 0.159.0 binary was inspected in an isolated idle tmux 3.6b pane.
Its `/status` output no longer has the earlier top/bottom box borders; field
values may wrap across display lines. The 0.159.0 parser therefore needs its
own complete-card boundary checks rather than relying on the old box corners.
The compact welcome header is also borderless, while the styled empty Composer,
shortcut footer, and model line remain recognizable.

The command popup, model picker, and reasoning picker were captured without
submitting a model or effort change. The model menu retains the
`enter default · s session` footer. The reviewed bottom-pane question, async,
model, and paste implementation is unchanged from 0.158.0. Transcript-level
Plan scrolling does not grant input authority to a modal or nonempty Composer.

The compiled bridge also completed the real closed `/status` transaction in an
80-column by 40-row owned pane: it parsed the new output, bound one exact native
thread on the 0.159.0 backend, verified the unchanged process incarnation, and
restored the styled empty Composer. No model task was started. The owned pane
was removed only after its terminal and process identity were rechecked.

These checks prove the UI and idle status-binding path, not model execution.
Existing 0.158.0 evidence does not prove a 0.159.0 question-answer or completion
result.

## Remaining boundaries

A first Watch requested while a blocking modal already owns the terminal cannot
safely run `/status`. Without an existing exact binding, it falls back to an
activity Watch with manual question handling. A Watch bound before the question
uses the exact response path when the current interaction permits it.

Paginated task Watches remain separate from legacy managed Sessions/Turns.
Managed session-only dispatch and native thread new/resume are not established
by this adapter. Embedded or remote server modes do not inherit the local
background-server foreground-binding proof. Older 0.157.x clients retain their
[documented limitations](codex-0.157.1-compatibility.md).

Store format remains 1, writer protocol remains 8, and Terminal Watch schema
remains 3. The version extension alone requires no store protocol upgrade.
An active Watch bound to a 0.158.0 backend is not silently migrated to 0.159.0;
its exact-version check still rejects that change. Create a fresh Watch after
upgrading the native client and backend.

## Validation status

- Local backend health: a read-only `initialize` returned version `0.159.0`,
  the expected Codex home, and macOS platform metadata on 2026-09-30. No native
  thread was read or resumed, no model task was started, and the daemon was not
  restarted for this check. This is connectivity evidence, not task-flow proof.
- Official 0.159.0 protocol and source delta review: completed against the tag
  above; the retained string-cursor and question/steering shapes are compatible.
- 0.159.0 terminal profile captures: completed for idle Composer, native status,
  command popup, model picker, and reasoning picker in an isolated tmux pane.
  No model task or model/effort change was submitted.
- Integrated native status bridge: passed against the installed 0.159.0 binary
  in an owned 80-by-40 tmux pane on 2026-09-30. Exact thread/version binding,
  unchanged PID/process birth, empty Composer restoration, and owned-pane
  cleanup were recorded. This health check started zero model tasks.
- Architecture and refactor-evidence validators: passed.
- Fast tests: 2,218 passed, zero failed or skipped.
- Full/release suites: not run during development under the repository policy.
  They are reserved for the immediate gate of an actual package publication.
- Real 0.159.0 async answer, blocking answer, manual Watch, exact completion,
  and callback probe: prepared separately, not run. It requires an explicit
  actual-publication gate and isolated owned tmux sessions. Its callback
  collector is local; an external chat delivery is a separate claim.

Publication must use the same runtime artifact that passes the native gate.
Final test totals, source and runtime hashes, and native outcomes belong here
only after they have been observed.

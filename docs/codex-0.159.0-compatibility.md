# Codex CLI 0.159.0 compatibility

This release candidate extends the existing [0.158.0 adapter](codex-0.158.0-compatibility.md)
to `codex-cli 0.159.0`. The official source target is
[`rust-v0.159.0`](https://github.com/openai/codex/tree/rust-v0.159.0), commit
`687a119f0fcaace47e1f1abcc77cec6c813fd6da`.
The protocol delta and terminal surfaces were reviewed against that version.
Fast regressions and the real native task gate passed; the full package-release
gate is still in progress.

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
prove the native async answer and completion sequence. The actual publication
probe verified that sequence on the installed version, as recorded below.

## Adapter contract

The 0.159.0 adapter retains the exact-task path used for 0.158.0:

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
The parser also separates the completed status fields from native Working and
queued async-question regions displayed below the card. The compact welcome
header is borderless, while the styled empty Composer, shortcut footer, and
model line remain recognizable.

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

These health checks establish the UI and idle status-binding path. The separate
0.159.0 native task gate below provides question-answer and completion evidence;
it does not inherit those claims from earlier 0.158.0 results.

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
- Fast tests: 2,220 passed, zero failed or skipped.
- Full/release gate: running as the immediate pre-publication gate for the actual
  0.13.13 release. No success is claimed until all of its stages finish.

The real Codex 0.159.0 task gate passed on 2026-09-30 against clean commit
[`b65fa53`](https://github.com/scotthuang/agent-knock-knock/commit/b65fa53ce1edbca7b18c2a38e49fe30d000b4837),
using the local background server and isolated owned tmux terminals:

| Native scenario | Observed result |
| --- | --- |
| Ordinary Send with an async Yes/No question | Exact accepted task; question callback; answer confirmed by durable client/message/question identity; correct final text and one completion callback |
| Manual Watch during that async task | Bound the same active turn; exact completion and one completion callback |
| Plan-mode blocking Yes/No question | Exact native request answered once and confirmed by its function output; correct plan body and one completion callback |
| Repeated reconciliation | No duplicate completion callback for any of the three Watches |

There were **three accepted model-task attempts in total**: one failed diagnostic
attempt, then two successful task scenarios on the final runtime. The first
attempt exposed a status parsing error: native Working and queued async-question
regions below the new borderless card were treated as malformed status fields.
Manual Watch binding and the answer's fresh identity check therefore failed;
that attempt did not confirm an answer or completion. The parser was corrected
before the final two-scenario gate was run. The final results are not reported
as if the first attempt had succeeded.

The callbacks were delivered to a local collector, not an external chat channel.
All owned probe terminals were cleaned up; no user terminal was changed and the
shared Codex daemon was not restarted. OpenClaw callback integration remains a
separate stage of the package-release gate.

The tested runtime contained 236 JavaScript files under `dist/src`. Its SHA-256
is `e9e91d3cdbfe7da371f2c53fe1acd103a4dd0b706eca386df4337c70233af138`,
computed over sorted relative paths, each followed by a NUL byte, file content,
and another NUL byte. The canonical Skill SHA-256 is
`77b05bfd78c8f5a3d3f301d76eadc35e8c538e9774e58a54129b769f7853d638`.
Final publication checks must compare the packaged runtime and Skill with these
native-tested artifacts.

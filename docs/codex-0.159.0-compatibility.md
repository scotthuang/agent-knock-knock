# Codex CLI 0.159.0 compatibility

AKK 0.13.13 extends the existing [0.158.0 adapter](codex-0.158.0-compatibility.md)
to `codex-cli 0.159.0`. The official source target is
[`rust-v0.159.0`](https://github.com/openai/codex/tree/rust-v0.159.0), commit
`687a119f0fcaace47e1f1abcc77cec6c813fd6da`.
The protocol delta and terminal surfaces were reviewed against that version.
Fast regressions, the real native task gate, and the full package-release
gate passed.

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
The parser also separates the completed status fields from the native activity
region, including Working, Thinking, Waiting, Compacting, dynamic status headers,
and queued async-question summaries. Their bounded render shape helps delimit
the card; the display text never proves task identity or authorizes input. The
compact welcome header is borderless, while the styled empty Composer, shortcut
footer, and model line remain recognizable.

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
- Full/release gate: passed as the immediate pre-publication gate for 0.13.13.
  All 2,735 full tests passed with zero failures or skips, followed by the
  OpenClaw 2026.9.1 compatibility check, ClawHub runtime validation, and publish
  dry-run. The separate legacy new/resume live smoke was not run because those
  actions are outside the paginated adapter contract.

The real Codex 0.159.0 task gate passed on 2026-09-30 against clean commit
[`a4f6b15`](https://github.com/scotthuang/agent-knock-knock/commit/a4f6b150ae9a1b7b3b9366fb1ec43c8fa74b796f),
using the local background server and isolated owned tmux terminals:

| Native scenario | Observed result |
| --- | --- |
| Ordinary Send with an async Yes/No question | Exact accepted task; question callback; answer confirmed by durable client/message/question identity; correct final text and one completion callback |
| Manual Watch during that async task | Bound the same active turn; exact completion and one completion callback |
| Plan-mode blocking Yes/No question | Exact native request answered once and confirmed by its function output; correct plan body and one completion callback |
| Repeated reconciliation | No duplicate completion callback for any of the three Watches |

There were **five accepted model-task attempts in total**: one diagnostic
attempt failed when native activity below the borderless card was misread as
status fields, two scenarios passed on an intermediate runtime, and both
scenarios passed again on the final runtime after covering Thinking, Waiting,
Compacting, and dynamic headers. The failed attempt confirmed neither an answer
nor completion. The results above refer to the final two successful scenarios;
intermediate successes are retained in the attempt count, not reused as proof
for the final artifact.

The callbacks were delivered to a local collector, not an external chat channel.
All owned probe terminals were cleaned up; no user terminal was changed and the
shared Codex daemon was not restarted. The separate isolated OpenClaw
integration stage also passed as part of the package-release gate.

The tested runtime contained 236 JavaScript files under `dist/src`. Its SHA-256
is `0bcd88903bd6ea2a693e3b88fa03e83282ad12951f40af735bc7fdee403a58bf`,
computed over sorted relative paths, each followed by a NUL byte, file content,
and another NUL byte. The canonical Skill SHA-256 is
`77b05bfd78c8f5a3d3f301d76eadc35e8c538e9774e58a54129b769f7853d638`.
Final publication checks must compare the packaged runtime and Skill with these
native-tested artifacts.

## Local terminal-routing follow-up (2026-09-30, not a release)

The checks above describe the published 0.13.13 artifact. A subsequent local
investigation reproduced additional failures in the user's Gateway environment
and Herdr terminal. Its changes and evidence are separate from that release.
An activity-only Watch's idle notification was not used as task-success evidence.

### Reproduced causes

- **tmux viewport:** tmux 3.6b renders a TAB in `display-message` as `_` when
  `LANG`, `LC_ALL`, and `LC_CTYPE` are absent, as in the running Gateway. The
  existing `akk:0.0` pane returned `213_63` with the old format and `213x63` with
  an ASCII `x` separator. It was not an undersized viewport. The reader now
  requires two positive safe integers separated by `x`; diagnostics contain
  bounded, redacted shape information rather than arbitrary terminal output.
- **Herdr viewport capture:** Herdr 0.8.0 interprets `pane.read` with `lines: 0`
  as an empty result. AKK's zero-scrollback capture means the current viewport,
  so the adapter now uses `source: visible` and omits `lines` for that case,
  for both text and ANSI captures. Positive scrollback requests are unchanged.
- **Codex fullscreen command popup:** the actual Herdr renderer splits Composer
  attributes across SGR sequences and uses Codex's selected-row blue background
  with dark text instead of reverse video. It also preserves background padding
  to the right edge. The parser now tracks SGR state, accepts the two known
  Codex selection palettes, and normalizes only trailing line padding when
  comparing plain and styled frames. It still requires an exact command/menu,
  a bold, non-dim Composer, and selection styling across the whole visible row.
  Copy selection, unknown styles, nonempty input, identity drift, and unrelated
  modals do not gain input authority.
- **Different foreground and daemon versions:** the designated physical TUI
  was `codex-cli 0.159.0`, while its existing shared daemon identified itself as
  `codex-tui/0.159.2`. A read of only the `/status`-bound thread confirmed the
  same thread/session ID and exact workspace. `thread.cliVersion` also came
  from the daemon; it is not proof of the physical executable's version.
  Treating all three values as one version incorrectly rejected Watch
  preparation before task submission. The reviewed daemon source is official
  tag [`rust-v0.159.2`](https://github.com/openai/codex/tree/ff6aec96948b70d94983af2641a6b67c94faeff5).
  Its protocol, paginated thread processor, and production TUI sources have no
  changes from 0.159.0; daemon implementation changes concern feedback reports.

The new terminal regressions exercise the actual renderer shapes, locale
failure, and zero-line behavior, including negative cases for unsafe styling,
malformed dimensions, and diagnostic leakage. Socket/pane identity, process
birth, ownership locks, approval checks, and one-shot input rules remain active.

Physical TUI and daemon versions are now bound separately. The reviewed pairs
are `(0.158.0, 0.158.0)`, `(0.159.0, 0.159.0)`, `(0.159.0, 0.159.2)`, and
`(0.159.2, 0.159.2)`; this does not enable arbitrary newer daemons or reverse
version combinations. The separately requested physical CLI upgrade is covered
in [0.159.2 compatibility](codex-0.159.2-compatibility.md).
A task anchor retains `codex_version` for the physical process
and records `backend_version` when the daemon differs. The extra field is
strictly validated and included in its fingerprint. Old anchors without it
retain their exact same-version meaning. Subsequent reads and answers require
the recorded backend version, so a daemon upgrade cannot silently migrate an
active Watch. Native UI operations continue using the physical TUI version.

### Native verification scope

The designated existing Herdr Codex was located by its actual working directory
`~/workspace/herdr-codex`, then fenced by stable terminal ID, PID, and process
birth. Neither the `~/workspace` pane nor the OpenClaw project pane was used as
a substitute. The existing process and conversation were retained. Its initial
native copy-selection mode was explicitly cleared only after two matching
frames and an empty Composer were verified. The old `/status` implementation
then reproduced the styled-popup failure before Enter; only that owned command
draft was cleared before testing the fixed transaction.

The original `akk:0.0` pane was used only for read-only viewport metadata checks
under both the Gateway's locale-free environment and a UTF-8 control environment.
Both returned 213 by 63 with the fixed provider. Input observations use an
additional owned tmux server, launched through the existing `mycodes --yolo`
wrapper in the designated workspace. This separate tmux observation does not
replace the required observation on the already-open Herdr session.

No existing Claude/Codex work session, shared Codex daemon, or Gateway is
restarted. The OpenClaw pane's earlier task result remains unverified; its idle
state or this repair's evidence must not be used to claim that task succeeded.
Callback transport observations use a local collector, not an external chat
notification. Unknown renderer styles and native thread new/resume retain the
boundaries above. Full, integration, and release suites are intentionally
excluded by `AGENTS.md` for this local work; there is no npm/ClawHub publication.

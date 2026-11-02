# Codex CLI 0.166.0 compatibility

AKK **0.16.11**, Pi **0.1.0-poc.19**, and DeepSeek Harness **0.1.0-rc.23**
include this review. The tested native pair is **macOS CLI 0.166.0 with
app-server 0.166.0**; this is not a numeric minimum for direct control.

## Protocol and UI review

Official installed 0.165.0 and 0.166.0 binaries generated **906 → 921**
experimental TypeScript schema files: 18 changed, 15 added, none removed.
Of the 34 previously selected AKK schemas, only `ThreadItem` changed: optional
flat `startedAtMs` / `completedAtMs` lifecycle fields. Existing bounded public
progress already retains valid item timestamps; timestamps do not establish
thread ownership or completion. New account, provider and telemetry schemas
are not new AKK operations.

The review compared status, model/permission menus, composer/footer,
blocking questions, async-question rendering and folder trust against the
official release tags. Native status adds `ChatGPT workspace`, changing field
alignment; AKK retains exact UUID/required-field checks and redacts the workspace
value along with Account. Native model and permission surfaces retain their
closed navigation and styling checks. The 0.166.0/0.166.0 terminal interaction
pair is explicit; unknown or mixed pairs do not inherit write authority.
Direct backend operations continue validating their own live contracts.

Async suggested choices now render Markdown as well as question titles.
Terminal matching accepts unchanged single-line plain labels and rejects an
unproven Markdown choice anywhere in the pending candidate set, including
nonselected choices. It never drops an ambiguous candidate to authorize a
lookalike. Native structured backend answers use the exact question/item IDs
and do not depend on screen Markdown matching.

## Verification record

A dedicated CLI was started through the existing proxy wrapper with `--remote`,
an isolated backend, private home/workspace and AKK Store. Existing user
processes and the shared backend were not restarted. The harness uses the
production public CLI dispatcher, native client/runtime, response service and
callback outbox, with a local callback receiver and in-process reconciliation.
This does not claim an independent monitor-process or WeChat delivery test.

| Capability | Evidence |
| --- | --- |
| Loaded discovery and first Send | Exact isolated owner selected; an unmaterialized empty thread accepted its first task. |
| Send, Status, progress and exact Watch | Two real tasks; bounded public progress ≤800 code points, original native turn retained, default deadline 720 minutes. |
| Idempotency and reconnect | Repeated Send retained its task; old Watch did not switch to a later turn; repeated observations produced one local completion receipt per task. |
| Native permissions | Read Only/Default effective-value round trips on the isolated thread. Initial custom read-only launch settings were explicitly converted to Read Only for this fixture, rather than claimed byte-identically restored. |
| Command approval | Exact harmless fixture command remained unexecuted until approve-once, then wrote once; repeated response caused no reexecution. |
| Blocking question | Native Plan-mode setup, followed by public AKK Watch/Status/Respond; exact Alpha answer and original-turn completion, duplicate response suppression. Plan setup is not an AKK Plan-mode setter. |
| Native terminal status/model transactions | Production `/status` transaction observed the exact UUID with one Enter and no task creation; public model-options read eight models, then set Sol medium and restored low with effective/default readback in the private home. |
| Terminal regressions | Retained versions plus 0.166 status, model/permission controls, folder-trust boundary, plain/Markdown ambiguity and mixed-version rejection. |

The release PR records actual fast/full/release gate results and any additional
real terminal captures. Source agreement and regression fixtures are distinct
from the real native tasks above. No fresh Desktop or old-version live matrix,
file-approval/rejection matrix, complex terminal Markdown-answer support,
production installation or external-channel delivery is claimed.

## Preserved limits

CLI paginated new/clear/resume lifecycle operations remain unsupported. Model
changes and Ctrl-C cancellation still require a verified applicable terminal;
this review does not add backend model/cancellation methods. Folder trust
requires a human decision in the original CLI. Unknown state cannot mean task
completion; uncertain input is never automatically resent or rerouted. Existing
absolute deadlines, managed-terminal 60-minute inactivity, persisted callback
receipts and recovery semantics are unchanged.

## Sources

- [Official 0.166.0 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0), published 2026-10-29 19:47:53 UTC.
- [Official release comparison](https://github.com/openai/codex/compare/rust-v0.165.0...rust-v0.166.0).
- [Async choice rendering](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/tui/src/bottom_pane/async_questions/mod.rs).
- [Native status](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/tui/src/status/card.rs).
- [Previous reviewed pair](codex-0.165.0-compatibility.md).

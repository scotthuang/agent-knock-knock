# Codex CLI 0.167.0 compatibility

AKK **0.16.12**, Pi **0.1.0-poc.20**, and DeepSeek Harness **0.1.0-rc.24**
include this review. The tested pair is **macOS CLI 0.167.0 with app-server
0.167.0**. This is a tested combination, not a numeric minimum for direct control.

## Protocol and UI review

The installed official 0.166.0 and 0.167.0 binaries generated **921 → 926**
experimental TypeScript schema files: 11 changed, five added, none removed.
All 34 selected existing AKK task/read/control schemas are unchanged. New
Guardian/section/audio fields do not become new AKK operations. The additional
`humanCommand` approval kind and optional `requiredHumanApproval` initialize
capability require a separate boundary below.

A focused comparison of 17 upstream TUI files found changes in the composer and
footer implementations. Status, model/permission menus, blocking/async question
rendering and folder trust retain their reviewed shapes. AKK adds explicit
0.167.0 profiles while retaining exact UUID, viewport, styled-popup, empty-input
and task-ownership checks. Terminal paginated interactions use the reviewed
0.167.0/0.167.0 pair; mixed or unknown pairs do not inherit write authority.
Backend operations continue validating their own live contracts.

## Person-only approvals

Codex 0.167.0 defines `humanCommand` as requiring a fresh decision from a person.
AKK does **not** claim `requiredHumanApproval`. If a person-only or unknown command
kind is observed, the native response client rejects it before sending a decision;
the public interaction retains its IDs, offers no automated action and directs
the user to the original CLI. Normal structured backend command approvals remain
supported.

The upstream TUI paints ordinary and person-only command approvals using the
same command dialog. A screen alone cannot establish the native kind. Therefore
0.167+ screen-only command approval is manual unless AKK can use the verified
structured backend route. File-edit and permission controls retain their separate
existing contracts. This restriction does not disable discovery, reads, ordinary
backend approvals, or question answers. Folder trust remains manual.

## Verification record

A dedicated CLI was launched with the existing proxy wrapper and `--remote`, an
isolated app-server, private home/workspace, dedicated tmux socket and AKK Store.
No production CLI, shared backend, Desktop or Gateway was restarted. The harness
uses the production public CLI dispatcher, native client/runtime, response service
and callback outbox. Completion receipts were accepted by a local receiver using
in-process reconciliation, not an independent monitor or external chat channel.

| Capability | Evidence |
| --- | --- |
| Discovery and first Send | Exact isolated loaded owner; an empty unmaterialized thread accepted its first task. |
| Send, Status, progress and exact Watch | Two real tasks; bounded public progress ≤800 code points, exact turn identity and default 720-minute deadlines. |
| Idempotency and reconnect | Repeated Send retained its task; an old Watch stayed on its original turn during a later task; repeated observations produced one local completion receipt per task. |
| Permissions | Read Only/Default effective-value round trips on the isolated thread. Custom read-only launch settings were explicitly converted to Read Only for the fixture, not claimed byte-identically restored. |
| Ordinary command approval | The exact harmless fixture write remained unexecuted before approve-once, then occurred once. A repeated response did not reexecute it. |
| Blocking question | Native Plan-mode setup, followed by AKK Watch/Status/Respond; exact Alpha answer, original-turn completion and duplicate response suppression. The setup is not an AKK Plan-mode setter. |
| Native terminal status/model | Exact-UUID production `/status` transaction with one Enter and no task creation; public model catalog and isolated Sol medium → low effective-value round trip. |
| Regression fixtures | Old reviewed profiles plus 0.167 status, model/permission, folder-trust, question ambiguity and exact-pair checks. Person-only/unknown native kinds cannot send a response or advertise an approval action; screen-only ambiguity remains manual. |

The release PR records actual fast/full/release results. Source review and fixture
coverage do not constitute a live person-only managed-policy test. No fresh
Desktop or old-version live matrix, full file-approval/rejection matrix, complex
terminal Markdown answers, production installation or WeChat delivery is claimed.

## Preserved limits

Paginated CLI new/clear/resume lifecycle operations remain unsupported. Model
changes and Ctrl-C cancellation still require an eligible verified terminal;
this review adds no backend model/cancellation method. Unknown state does not
mean completion. Uncertain input is never automatically resent or rerouted.
Existing absolute deadlines, managed-terminal 60-minute inactivity, persisted
callback receipts, List v5 budgets and recovery semantics are unchanged.

## Sources

- [Official 0.167.0 release](https://github.com/openai/codex/releases/tag/rust-v0.167.0), published 2026-11-06 01:40:00 UTC.
- [Official release comparison](https://github.com/openai/codex/compare/rust-v0.166.0...rust-v0.167.0).
- [Human approval capability](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/common.rs).
- [Approval overlay](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/bottom_pane/approval_overlay.rs).
- [Async question rendering](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/bottom_pane/async_questions/mod.rs).
- [Previous reviewed pair](codex-0.166.0-compatibility.md).

# Codex CLI 0.169.0 compatibility

AKK **0.16.15**, Pi **0.1.0-poc.23** and DeepSeek Harness **0.1.0-rc.28**
include this review. The live-tested pair is **macOS CLI 0.169.0 with app-server
0.169.0**. This is a tested combination, not a numeric minimum for direct control.

## Native protocol and terminal review

The installed official 0.167.0 and 0.169.0 binaries generated **926 → 951**
experimental TypeScript schema files: **28 changed, 25 added, none removed**.
Review covered the existing initialization, loaded-thread discovery, read/items,
subscription, Send, settings, approval and question contracts used by AKK.

- A native `attachedToThreadId` now identifies an attached thread. AKK excludes
  it from independent main-CLI discovery while preserving its source owner;
  matching project paths or titles never replace exact thread identity.
- Agent messages can carry `moderation` and display directives. CLI public
  commentary, final Status/results, completion callbacks and async questions
  accept legacy messages or an explicit unmoderated/no-display directive.
  Moderated, display-directed or malformed metadata never exposes raw text.
  Completion remains a separate native task fact even if no public text exists.
- Optional tool-output deferral and settings/environment fields are additive.
  AKK does not request deferred output or claim a new environment/Cloud API.
  Existing settings updates leave omitted environment selections untouched.

A focused comparison of 17 upstream TUI files found unchanged status cards,
permissions/trust dialogs and question renderers, with changes in composer,
footer and model-menu implementations. Reviewed 0.169.0 profiles retain exact
UUID, viewport, styled-popup, empty-input and ownership checks. Terminal
paginated interactions use the reviewed 0.169.0/0.169.0 pair; mixed or unknown
pairs do not inherit write authority. Backend controls validate their own live
contracts. Old reviewed profiles remain covered by regression fixtures.

## Verification scope

A dedicated CLI used the existing proxy wrapper, `--remote`, an isolated
app-server, private home/workspace, dedicated tmux socket and AKK Store. No
production CLI, shared daemon, Desktop or Gateway was restarted. The harness
uses the production public CLI dispatcher, native runtime, response service and
callback outbox. Receipts are from a local callback receiver with in-process
reconciliation, not an independent monitor or external chat delivery.

| Capability | Evidence |
| --- | --- |
| Discovery / empty-thread bootstrap | Exact loaded owner and the first task on an unmaterialized empty thread. |
| Attached-thread identity | A real native attached fork remained loaded, was excluded from main-CLI discovery, and left the source owner discoverable. No model task was sent to the attached thread. |
| Send / Status / public progress / Watch | Real model turns, bounded progress ≤800 code points, exact turn anchors and default 720-minute deadlines. |
| Replay / reconnect / old Watch | Duplicate Send retained its original task; an old Watch stayed on its own turn during a later one. Repeated observations produced one local completion receipt per task. |
| Permissions | Read Only → Default → Read Only effective-value round trip on the isolated thread. Custom launch settings were explicitly converted to standard Read Only for this fixture, not claimed byte-identically restored. Full Access was not changed. |
| Native terminal status | Exact-UUID `/status` transaction, one Enter, no task/receipt/monitor creation. |
| Model control | Public catalog and isolated Sol medium → low effective-value round trip. |
| Ordinary approval | Exact harmless fixture command remained unexecuted until approve-once, then wrote once. Duplicate approval did not reexecute it. |
| Blocking question | Native Plan-mode setup followed by AKK Watch/Status/Respond, exact Alpha answer, original-turn completion and duplicate response suppression. The setup is not an AKK Plan-mode setter. |
| Folder trust | Upstream renderer unchanged and existing blocked/no-input regression retained. Isolated remote launches did not present the dialog, so live trust handling is not newly verified. No Trust selection was sent. |
| Automated regression | Old and 0.169 status/model/permission/question profiles, exact-pair restrictions, attached-thread filtering and presentation-metadata privacy. |

The release PR/verification record supplies actual fast/full/release results.
Real upstream message-moderation delivery and async questions were not induced;
their new metadata boundaries use protocol review and deterministic regression.
No fresh Desktop/old-version live matrix, full file-approval/rejection matrix,
complex terminal Markdown answers, production installation or WeChat delivery is
claimed. Pi/DSH Host ranges are unchanged; SDK registration and isolated package
smokes do not imply live model consumption through those Hosts.

## Preserved boundaries

Person-only `humanCommand` approvals still require a person in the original CLI;
AKK does not claim `requiredHumanApproval`. A screen-only 0.167+ command dialog
cannot establish its native kind. Ordinary structured backend approvals remain
available. Folder trust is manual and unknown dialogs are not guessed.

Paginated CLI new/clear/resume lifecycle operations remain unsupported. Model
changes and Ctrl-C cancellation still require an eligible verified terminal;
this review adds no backend model/cancellation method. Uncertain input is never
automatically resent or rerouted. Existing absolute deadlines, managed-terminal
60-minute inactivity, persisted callback receipts, List v5 budgets and recovery
semantics are unchanged. Desktop transport compatibility is a separate review.

## Sources

- [Official 0.169.0 release](https://github.com/openai/codex/releases/tag/rust-v0.169.0), published 2026-11-13 08:37:05 UTC.
- [Official source comparison](https://github.com/openai/codex/compare/rust-v0.167.0...rust-v0.169.0).
- [Native thread metadata](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
- [Native item/display contract](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs).
- [Terminal composer](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/bottom_pane/chat_composer.rs).
- [Previous reviewed pair](codex-0.167.0-compatibility.md).

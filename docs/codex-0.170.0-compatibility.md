# Codex CLI 0.170.0 compatibility

AKK **0.16.18**, Pi **0.1.0-poc.26** and DeepSeek Harness **0.1.0-rc.31**
include this review. The live-tested pair is **macOS CLI 0.170.0 / app-server
0.170.0**. These are tested versions, not a numeric minimum for direct control.

## Why a terminal Send could be refused

The error `Codex composer contains non-placeholder input or is not at the exact
idle prompt` occurs before the native `/status` transaction can establish the
exact task identity. It is an input-surface proof failure, not a tmux/Herdr
release-number check. A draft, history viewer, busy state, unknown dialog or
changed input owner can correctly produce a refusal.

One false refusal was reproduced: a complete styled Composer and a closed
model/path footer without a separate shortcuts row were accepted only for an
explicit list of Codex versions. The same valid shape on a new release was
rejected before input. Ordinary Composer proof now checks the observed frame,
not that release list. Both tmux and Herdr regression cases include an unlisted
patch release. Unknown footer content and unproven frames still fail closed.
The remote reporter's screen was unavailable, so the error alone does not prove
that this was their exact UI shape. A fresh 0.170.0 two-row footer also passed
on the previous implementation; this was never a universal 0.170.0 failure.

The actual frontend version remains separate from the backend version.
Protocol-specific terminal questions/settings still use reviewed profiles and
frontend/backend pairs. Equivalent backend operations validate the live native
contract. This patch does not guess unknown interaction schemas or disable
identity, process, viewport, approval, draft or uncertain-send protections.

## Protocol and renderer evidence

The official installed 0.169.0 and 0.170.0 binaries generated **951 → 957**
experimental TypeScript files: **4 changed, 6 added, none removed**. Existing
initialization, loaded discovery, read/items, subscription, task submission,
ordinary approvals/questions and settings contracts used by AKK remained
compatible. Agent-message display metadata changed to a versioned show/hide/
block union. The CLI compatibility review preserved its conservative rule: display-directed,
moderated or unknown presentation metadata does not expose raw message text in
progress, final results or callbacks. Regression includes known and unknown
versions. A biometric metadata addition does not authorize person-only approval.
The subsequent [Desktop recovered-answer policy](codex-desktop-compatibility.md#reading-a-desktop-answer)
applies versioned `show` instructions to explicit Desktop reads and the original Send's completion callback.

Official TUI review covered status, permission, model, question and composer
renderers. Status cards, permission menus and question layouts retain their
existing structures; composer/footer and application focus code changed.
The reviewed 0.170.0 profile retains exact styled selection and empty-input
proofs. Earlier reviewed profiles remain covered by regression fixtures.

## Isolated verification

The existing proxy wrapper launched dedicated CLIs, a private app-server/home/
workspace, a private tmux socket and a separate Herdr 0.9.5 server. Only those
owned test resources were controlled. No user's running CLI, Desktop, Gateway,
shared daemon, configuration, Watch or callback record was changed.

- Real backend task submission and native acceptance, public commentary/tool
  progress bounded to 800 code points, exact completion and default 720-minute
  monitoring. Replayed Send retained its original turn; old Watch stayed on its
  own turn after later work. Repeated observations did not duplicate local
  completion receipts.
- Native terminal `/status` with exact UUID in tmux 3.8 and Herdr 0.9.5.
- Public model catalog and isolated Sol reasoning-effort medium → low round trip.
- Isolated Read Only → Default → Read Only permission readback. Custom launch
  settings were explicitly converted to standard Read Only for this fixture;
  no byte-identical restoration of custom settings or Full Access test is claimed.
- Ordinary command approval: an exact harmless fixture command did not execute
  before approve-once, wrote once afterward, and duplicate response did not
  execute it again. One local completion receipt was observed.
- Blocking question: native Plan-mode task setup, then public AKK Watch/Status/
  Respond with the exact Alpha option, original-turn completion and duplicate
  response suppression. The setup is not an AKK Plan-mode setter. No separate
  async question was induced.
- Actual terminal fallback submission and exact native completion in both
  hosts. Backend discovery alone was deliberately made empty in the harness
  to exercise fallback; terminal identity/preflight, physical transport and
  model execution were real and unchanged. One task text was delivered per
  target. This is not evidence of a production backend outage.

Local callback delivery uses the production outbox with an isolated receiver
and in-process reconciliation, not a fresh independent-monitor or WeChat test.
The release evidence records actual test commands/counts separately from these
real model/transport observations. SDK clean-install registration is not live
Pi/DSH model consumption. Desktop compatibility is unchanged.

## Preserved limits

Person-only `humanCommand` approvals and folder trust remain manual. A screen-
only command dialog cannot prove the native approval kind. Lifecycle new/clear/
resume on paginated CLIs remains unsupported; model changes and Ctrl-C require
an eligible verified terminal. Unknown schemas are not answered. No uncertain
input is resent or rerouted. Existing deadlines, 60-minute managed inactivity,
List v5 budgets, immutable receipts and recovery semantics are unchanged.

No fresh old-version live matrix, async-question rendering, complete rejection/
file-approval matrix, real moderation event, production install or external-chat
receipt is claimed. See the release evidence for the ordinary command approval
and blocking-question checks and their exact setup boundaries.

## Sources

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.170.0), published 2026-11-18 03:40:48 UTC.
- [Official source comparison](https://github.com/openai/codex/compare/rust-v0.169.0...rust-v0.170.0).
- [Composer](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/bottom_pane/chat_composer.rs).
- [Footer](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/bottom_pane/footer.rs).
- [Status card](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/status/card.rs).
- [Permissions](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/tui/src/chatwidget/permissions_menu.rs).
- [Previous review](codex-0.169.0-compatibility.md).

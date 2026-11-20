# Codex CLI 0.171.0 compatibility

AKK **0.16.20**, Pi **0.1.0-poc.28** and DeepSeek Harness **0.1.0-rc.33**
include this review. The tested combination is Codex CLI 0.171.0 and
app-server 0.171.0 on macOS arm64. Direct control requires a loaded conversation
and successful live contract checks.

## What changed

Codex 0.171.0 enables the TUI workspace by default, changes Composer editing
and introduces GPT-6.2 Sol and Astra in the model catalog. The standard
full-screen Composer kept its model/path footer, styled input marker and slash
completion rows. AKK 0.16.19 already discovered the isolated 0.171.0 thread,
sent through the shared app-server and read the original UUID with `/status`.

The new profiles cover the reviewed 0.171.0 terminal status, model, permission
and question contracts. An exact paginated task interaction still requires a
verified frontend/app-server pair. The regression checks also cover mixed
0.170.0 and 0.171.0 pairs and preserve the input ownership, draft and modal
checks. Ordinary terminal input still uses the observed Composer structure and
supports custom model labels in the format introduced in AKK 0.16.19.

The installed binaries generated 957 and 968 experimental TypeScript protocol
files for 0.170.0 and 0.171.0. Of the common files, 22 changed. The comparison
found 13 additions and two removals. The typed request shapes for loaded
discovery, turn submission, approvals and blocking questions are unchanged.
The MCP registration environment identifier is additional metadata. AKK
neither uses it as a session identity nor includes raw tool arguments in
public progress.

## Isolated checks

- Dedicated CLI and private app-server through the existing Codex launcher.
  Loaded discovery, first Send on a thread with no history, public progress,
  exact completion and local callback receipts passed. An idempotent Send kept
  the same task and an old Watch stayed on the original turn. The progress
  budget was 800 code points and the default Watch lifetime 720 minutes.
- tmux and Herdr each returned the exact native UUID via `/status` and then
  submitted one physical task that completed on that thread. The harness
  substituted an empty direct-discovery result to exercise terminal fallback.
  The terminal providers, input checks and native task execution were real.
- The native GPT-6.2 Sol model catalog and reasoning effort round trip from Low
  to Medium and back passed in the isolated tmux session. The isolated
  Read Only → Default → Read Only permission round trip passed through the
  shared backend after selecting the standard Read Only profile.
- A typed approval for one harmless fixture write executed once after an
  exact approve-once response. Repeating the same response did not repeat the
  write or completion receipt.
- A native Plan-mode turn produced a blocking single-choice question. AKK
  Watch, Status and Respond observed and answered the exact request. The
  selected option appeared in the original turn's final answer. Repeating
  the response produced no additional native attempt.

The callback test uses a local receiver and in-process reconciliation. The
standalone monitor, external messaging delivery, preview panel focus, nested
workspace input, live asynchronous questions, Desktop and old-version live
combinations were outside these checks. Folder trust and person-only
approvals remain manual.

See the [verification summary](evidence/codex-0.171.0.json) for captured results.

## Sources

- [Codex 0.171.0 release](https://github.com/openai/codex/releases/tag/rust-v0.171.0).
- [Official source comparison](https://github.com/openai/codex/compare/rust-v0.170.0...rust-v0.171.0).
- [Terminal footer](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/bottom_pane/footer.rs).
- [Previous compatibility review](codex-0.170.0-compatibility.md).

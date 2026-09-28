# Codex CLI 0.157.1 compatibility

Reviewed on 2026-09-29 against the locally installed `codex-cli 0.157.1` and
official tag `rust-v0.157.1` (commit
`36650394c5b38c2990ccf2a3457165ca3e9d9726`). This is partial compatibility;
0.157.1 is not an exact verified native-action profile.

| Capability | Result |
| --- | --- |
| Process discovery and version detection | Supported |
| Fullscreen idle/working activity | Supported as diagnostic evidence, using the complete observed two-line footer |
| Parsing the native `/status` card | Supported, including `Server`; account values remain redacted |
| Automated native `/status` dispatch | Unavailable; the fullscreen command popup does not satisfy the old input contract |
| Explicit physical terminal Send | Retains the ordinary input-owner and process safety checks |
| Terminal-activity Watch | Best-effort activity/settlement only; cannot attest exact task completion |
| Managed Send with durable completion callbacks | Refused before terminal input on 0.157.0/0.157.1 |
| Native new-thread/resume | Unavailable on 0.157.0/0.157.1 |
| Automated questionnaire answers and typed model control | No verified 0.157.1 profile; unavailable |
| Paginated historical sessions | Metadata remains visible; stale legacy rollout paths cannot supply context or lifecycle candidates |

## Why managed monitoring is unavailable

[0.157.0 introduced the default shared background server and fullscreen
transcript](https://github.com/openai/codex/releases/tag/rust-v0.157.0).
0.157.1 inherits these contracts; its patch changes primarily affect Windows
process and PTY handling.

The [TUI thread-start request](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/app_server_session.rs#L2048)
selects paginated history for every new durable thread. `--no-daemon` changes
the transport, and `tui.fullscreen_transcript=false` changes rendering; neither
restores legacy JSONL history. Ephemeral mode removes persistence altogether.

AKK currently derives exact task identity and completion from a verified
rollout descriptor owned by the physical terminal process. A shared server's
open files belong to multiple sessions and cannot be assigned to a terminal
by cwd or recency. The isolated local fullscreen pane had no rollout
descriptor, and its existing shared server ran a different version from the
0.157.1 TUI. The installed CLI version therefore does not prove the server
version or current task identity.

Paginated sessions can also retain an obsolete `rollout_path` in the metadata
database. AKK now reads `history_mode`, exposes such sessions as metadata only,
and excludes them from legacy context and lifecycle authority. Old databases
without this column continue to use their legacy contract.

The native fullscreen capture also exposed a terminal-hyperlink stripping bug:
multiple OSC links could consume the `/status` command and card header between
them. Each link now stops at its own terminator, preserving the visible status
evidence.

The isolated CLI health probe also tested the advertised native-status action.
It stopped at the exact Composer/menu check after typing `/status`, without
proving Enter dispatch. The new popup appears above the Composer and uses an
uppercase model footer. This action is now unavailable before input until its
new menu and freshness contract are independently verified; visible status
cards remain readable.

## Questions and the remaining adapter work

The [async-question implementation](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/bottom_pane/async_questions/state.rs)
now uses per-question durable identities and `user.answered_question` reply
envelopes. Key hints use compact labels such as `ctrl+]` and `⌥+↓`. Blocking
question labels also changed. Turn completion can clear pending questions and
restore an unsent answer draft to the main Composer.

These changes need a paginated history adapter, an exact fresh foreground
thread proof, server-version verification, and independent question-answer
settlement evidence. Copying the 0.155.1 profile would bypass those proofs.
Expanded question editors continue to block ordinary Send even with the newer
compact key labels.

The regression suite covers diagnostic footer boundaries, working priority,
missing/changed UI rows, read-only status parsing, zero-input managed and
lifecycle refusal, history migration, and legacy database compatibility.
The local `--no-daemon` startup probe ended with Codex's own `account/read`
workspace-routing timeout; it supplies no successful standalone lifecycle
evidence. No real model turn or external callback was used for this review.

# Codex CLI 0.160.0 compatibility

This review follows the official stable `rust-v0.160.0` release (2026-10-01),
not the `0.162.0-alpha` channel. AKK 0.13.18 also reviews the 0.159.3
foreground client because already-running clients can share the upgraded
0.160.0 app-server.

## Contract review

The native binaries generate byte-identical experimental TypeScript schemas
across 0.159.2, 0.159.3, and 0.160.0 (875 files), and byte-identical JSON
schemas between 0.159.3 and 0.160.0 (440 files). The official source comparison
also preserves paginated history, thread/turn identity, request-user-input,
and async-answer wire shapes. Runtime response validation remains required;
schema equality alone does not authorize a native write.

The 0.160.0 macOS Option-key hint no longer contains a plus sign:
`⌥↑ to answer`, `⌥↓ main prompt`, and `⌥↑ next question`. AKK uses a distinct
async UI profile for this grammar. Older frontends retain their old spelling;
unknown or mixed keymaps remain non-executable. The native status reader
accepts both closed display spellings without granting input authority.

Native model, permission, questionnaire, and status profiles cover 0.159.3 and
0.160.0. The new projectless `Workspace (granular)` default is represented as
`workspace_granular`, a current-only state. Its actual native picker offers
three standard presets with no current marker. AKK may select a freshly
advertised preset; it never treats granular as Ask for approval, exposes it as
a selectable target, or accepts arbitrary custom/granular labels. New status cards may omit reasoning summaries on server connections;
this field is not an identity requirement. Plan footer hints remain display
information, not task identity.

Exact audited interaction pairs are:

| Foreground CLI | app-server | Basis |
| --- | --- | --- |
| 0.159.3 | 0.159.3 | Identical protocol and reviewed source; regression tests |
| 0.159.3 | 0.160.0 | Shared-backend upgrade pair; native verification below |
| 0.160.0 | 0.160.0 | Current stable pair; native verification below |

Existing audited older pairs remain available. The reverse 0.160.0/0.159.3
pair, 0.159.2/0.160.0, and unreviewed later pairs do not gain answer authority.
Read-only contract negotiation continues to support compatible newer backends;
a changed backend can retain exact observation, but withdraws an executable
question offer until its own fresh authority is established.

## Verification

On 2026-10-04, isolated macOS tmux sessions ran the actual 0.159.3/0.160.0
and 0.160.0/0.160.0 foreground/backend combinations. Every launch used the
existing `mycodes` wrapper; an owned PATH shim selected the old executable for
the mixed pair. No user terminal or shared daemon was restarted.

Both pairs passed two real model turns each, through built production adapters:

- Discover the exact process and pane; capture a fresh native status/thread.
- Send once, prove exact native request acceptance, and attach an automatic
  paginated task Watch.
- Attach another exact Watch while the same async task is working.
- Receive the async question callback; answer once to that exact turn, then
  prove the matching durable user-message/question ID.
- Receive and answer a native Plan-mode blocking question; prove the canonical
  function output before treating its answer as confirmed.
- Prove the exact native turn completed with the requested nonce and answer;
  repeated reconciliation delivers exactly one completion callback per Watch.

A separate real 0.160.0 pane passed native `/status` identity, model catalog
inspection without changing its model/effort, and permission discovery followed
by Ask for approval → Full Access (including native confirmation) → Ask for
approval. Every permission result was confirmed against the same thread and
fresh status/menu, with `defaults_changed=false`. The initial read-only state
was not selectable in this platform's picker; cleanup retained the final
standard preset only in the disposable test session.

The final candidate also passed the production permission APIs starting from
an actual `Workspace (granular)` session: discovery returned only the three
standard choices, followed by granular → Full Access → Ask for approval. Both
changes had fresh same-thread status/menu confirmation and unchanged defaults;
model and effort remained unchanged. The prior invalidated Watch stayed
invalidated throughout, and no task was resent or revived.

Callbacks were collected at the production Watch transport boundary in a local
sink. This proves AKK callback generation/deduplication, not delivery to an
external chat service. The live terminal used the `shift+arrow` keymap; the new
macOS Option spelling and Plan-cycle hint have official-source and regression
coverage, not live-keymap coverage. Herdr transport, remote endpoints, other
platforms, native model-setting commits, and command approval prompts were not
newly exercised live in this review.

An initial isolated attempt exposed the existing strict cwd boundary: macOS
`/var/...` was later persisted as `/private/var/...`, so its Watch was correctly
invalidated and was not revived or resent. Passing runs used physical canonical
workspace paths from launch. Launching through other symlink paths can still
encounter this conservative identity limitation.

`npm run test:fast` passed 2,464 tests; type checking, build, and architecture
validation passed. The immediate pre-publication `npm run test:release` gate
passed 2,979 tests, isolated OpenClaw 2026.9.1 compatibility (24 tools,
callback delivery, install/update/uninstall), ClawHub runtime validation, and
publication dry-run. The general native lifecycle smoke was not run because
paginated new/resume remains outside the supported path; the targeted native
proof above covers this release's actual task and permission paths.

## Retained boundaries

- Ordinary List/Status reads live terminal activity. Without an existing exact
  anchor it does not invent a native task identity, type `/status`, or create a
  Watch. A same-workspace history guess cannot prove task completion.
- Exact Send/Watch preparation uses the existing locked native status
  transaction, then validates the native thread, turn, request, and durable
  completion. Compatible reads do not bypass input-owning modal or styled
  Composer checks.
- A first Watch on an already-blocking question without a prior task anchor
  remains activity-only/manual-response. Safe fallback is explicitly labeled
  `terminal_activity`; idle is not proof of task completion.
- Paginated managed session-only dispatch and native new/resume remain outside
  this adapter. The upstream permission-resume changes do not enable them.
- No existing user TUI or shared daemon needs to restart for installation.
  Updating the CLI changes future launches; running processes retain their
  loaded version. Explicit restarts must preserve the wrapper and exact UUID.

## Sources

- [Official 0.160.0 release](https://github.com/openai/codex/releases/tag/rust-v0.160.0)
- [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [0.159.2 to 0.159.3 source comparison](https://github.com/openai/codex/compare/rust-v0.159.2...rust-v0.159.3)
- [0.159.3 to 0.160.0 source comparison](https://github.com/openai/codex/compare/rust-v0.159.3...rust-v0.160.0)

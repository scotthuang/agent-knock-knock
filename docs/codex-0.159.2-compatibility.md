# Codex CLI 0.159.2 compatibility

AKK 0.13.14 adds `codex-cli 0.159.2` and repairs the terminal-routing
failures described in the [0.159.0 follow-up](codex-0.159.0-compatibility.md#local-terminal-routing-follow-up-2026-09-30-not-a-release).
The native observations below were collected before publication. The user
subsequently tested the locally installed candidate successfully; publication
checks are recorded separately from those observations.

The official source target is `rust-v0.159.2`, commit
[`ff6aec96948b70d94983af2641a6b67c94faeff5`](https://github.com/openai/codex/tree/ff6aec96948b70d94983af2641a6b67c94faeff5).
Compared with 0.159.0, the app-server protocol, paginated thread processor, and
production TUI sources have no changes. TUI differences are confined to tests
and snapshots; app-server implementation differences concern feedback reports.
The terminal status, fullscreen Composer, async question, questionnaire, and
model/plan profiles therefore use the existing 0.159 UI contract with an exact
0.159.2 version identity.

## Foreground and shared backend versions

The foreground executable and shared daemon are independently installed. An
already-open 0.159.0 process can remain connected to the existing 0.159.2 daemon
after the standalone CLI is updated. `initialize.userAgent` and the thread's
`cliVersion` describe that daemon; neither replaces physical process/version
verification.

AKK binds both versions. The only supported pairs are 0.158.0/0.158.0,
0.159.0/0.159.0, 0.159.0/0.159.2, and 0.159.2/0.159.2. Initial negotiation
permits only these reviewed pairs. Every subsequent read and answer pins the
actual bound daemon version. A backend change invalidates that expectation; an
old Watch is never silently migrated.

The paginated task anchor keeps `codex_version` as the physical TUI version and
uses an optional `backend_version` for a different daemon version. The field is
covered by strict validation and the anchor fingerprint. Missing fields in old
anchors retain same-version semantics. Older readers reject mixed-version
anchors instead of interpreting them as same-version tasks. UI/terminal safety
checks continue to use the physical version, exact process birth, and canonical
terminal identity.

## Terminal and answer corrections

The original tmux failure was not caused by window size. With all locale
variables absent, tmux 3.6b rendered the tab in the old dimension format as an
underscore (`213_63`). The provider now requests a strictly parsed ASCII
`213x63` format. Its diagnostics summarize command and socket identities with
hashes rather than exposing their raw paths.

Herdr 0.8 returns no text for `pane.read` with `lines: 0`. AKK now requests the
visible viewport with that argument omitted when its caller requests zero
scrollback lines. The native `/status` selection also uses truecolor foreground
and background attributes instead of the reverse-video attribute expected by
the old parser. The finite-state style check recognizes the observed native
palette, verifies all visible selected-row cells, and rejects partial, dimmed,
reset, or unknown selections.

Normal output updates the macOS TTY device's change timestamp. Herdr viewport
inspection no longer treats that timestamp as a device replacement. Device,
inode, device number, owner, character-device type, non-symlink status, terminal
identity, and process birth checks remain in force. Socket identity checks are
unchanged.

At 29 rows, a working indicator and tip can push the native status header above
the visible viewport. Herdr's visible/detection reads cannot expose that hidden
content by requesting more lines. The private paginated binding transaction now
supports one native PageUp followed by Ctrl+End. It joins only a unique,
nonblank overlap between captured frames, requires the real version header and
complete strict status card, and verifies restoration of the original card tail
before returning an identity. Every capture and key rechecks terminal identity.
Drafts, selection mode, unknown history chrome, ambiguous overlap, or failed
restoration stop the operation. The header is never synthesized from cached
metadata. Native observations at 91 by 24 exercised clipping without creating a
model task; the required existing Herdr session retains its 91 by 29 geometry.

Herdr 0.8.0's key-name parser omits PageUp and End. Its official terminal
encoder defines PageUp as `ESC [ 5 ~` and Ctrl+End as `ESC [ 1 ; 5 F`.
For just these two singleton semantic keys, the provider uses the official
`pane.send_text` direct-input endpoint with those fixed constants. Ordinary
text retains `pane.send_input` and its bracketed-paste behavior. Mixed navigation
batches are rejected before input; stable-resource resolution, socket identity,
response correlation, and uncertain-delivery fencing are unchanged. No caller
can provide arbitrary raw bytes through this key path.

Working and queued-question chrome can remain visible while browsing history;
the existing strict native suffix grammar separates it from the card. If the
first PageUp exposes a compatible but non-overlapping partial status prefix,
one optional closed WheelDown event advances three transcript rows. Eligibility
uses the same strict card grammar, including a command-only prefix immediately
before its header; that temporary adjacency never supplies binding evidence. It requires a freshly matching paused frame and
exact viewport, targets the fixed transcript position (2,2), and exposes no
caller-selected coordinates or bytes. Both providers send the official SGR
wheel encoding without paste framing. Multiple candidate overlaps never
authorize this fallback. A unique nonblank overlap and successful restoration
are still required afterward. This is a bounded transaction, not an unbounded
history scan or a relaxation of the identity parser.

The native queued-question suffix can add or remove a 1–20 second countdown.
That countdown is display state, not an automatic answer or popup timer; it is
normalized only while comparing otherwise identical native chrome. The exact
`New activity` paused-view prefix is also recognized. Restoration alone permits
a known task-finished or question-count transition, while still requiring a
fresh native paused footer, matching model/path, and an empty styled Composer.
Unknown chrome or a draft forbids restoration input. A changed status card
after restoration cannot return the earlier binding.

This navigation is confined to the private closed binding used by Send/Watch
and response preflight. Public `native_inspect(status)` remains idle-only; it
still fails safely if its own full status card cannot fit. The ordinary 91 by
29 public inspection was observed separately on both physical CLI versions.

One native async answer was recorded about 7.4 seconds after submission, beyond
the previous five-second confirmation window. Answer delivery now keeps the
transport RPC deadline separate from a 15-second read-only receipt observation
window. An RPC error or an early completed-turn status cannot establish that
the answer was lost. Only the unique receipt matching the submitted client ID,
payload, native turn, and question tuple confirms it. There is still exactly
one answer submission; unresolved outcomes remain fenced against automatic
retry.

## Local upgrade and validation boundary

The installed CLI uses the official standalone layout under
`~/.codex/packages/standalone`; its visible entry is `~/.local/bin/codex`.
The existing `mycodes` wrapper supplies the configured SOCKS proxy and remains
unchanged. The existing latest update channel is retained. Updating the visible
executable does not restart existing TUI processes or the shared daemon.

The required old Herdr session is identified by its actual directory
`~/workspace/herdr-codex`, stable terminal ID, PID, and process birth. It is not
replaced by a different directory or silently restarted to make the version pair
match. Separate owned tmux sessions exercise locale-free viewport access and the
new executable without interrupting user sessions.

Fast regressions and targeted native observations are distinct evidence. The original local task did not authorize the full/integration/release tier;
the subsequently authorized publication uses the standard release gate. Native
callbacks are collected locally, so this work does not establish external chat
delivery. Managed native new/resume, unrecognized terminal styles, and a first
Watch while an unbound blocking modal owns the terminal retain the documented
0.159.0 limitations. The protected OpenClaw pane's previous task result is not
part of this verification.


## Combined candidate results (2026-09-30)

The combined local candidate includes the Claude 2.1.285 adapter described in
[its separate report](claude-2.1.285-compatibility.md). `npm run test:fast` passes
**2,336 tests**, with zero failures, cancellations, or skips. The fast build also
checks TypeScript and canonical Skill replicas. Architecture and refactor-evidence
validators pass without increasing production size budgets.

The tested runtime contains 238 JavaScript files under `dist/src`. SHA-256 is
`e71abb37ee38717830b9acff4642f5c07c45670b6f76050897e46b08b59cb97f`, over sorted
repository-relative paths followed by NUL, content, and NUL. The canonical Skill
SHA-256 is `57c70aadbf8e48f05e11d2841c4889b7815d92bdee6fd20cedfa1e73e9da1eff`.
These hashes identify a local candidate, not a release attestation.

Native observations call compiled production terminal, Send, Watch, response,
and durable callback components with real I/O, a private Store, and local callback
collector. They are not unit mocks. All terminal mutations retain the global AKK
ownership lock and verify the physical endpoint, process birth, and exact workspace.

| Native scenario | Actual evidence |
| --- | --- |
| Existing Herdr `~/workspace/herdr-codex` | Physical 0.159.0, existing backend 0.159.2; original process and conversation retained |
| Herdr Send and Watch | Auto Watch accepted the real prompt; an additional running-task Watch bound the same native turn |
| Herdr question and answer | Exact single-select question notification; one native Yes response, durable receipt `confirmed` |
| Herdr completion | Expected marker returned; each exact Watch delivered one completion callback; two extra reconciliations produced no duplicates |
| New 0.159.2 tmux, locale variables absent | Real process launched through unchanged `mycodes --yolo`; exact Send binding, question, one confirmed Yes, and one exact completion callback passed |
| 0.159.2 manual Watch after output settled | A fresh guarded probe bound the same running turn; auto and manual exact Watches each delivered the expected completion marker once |
| Existing `akk:0.0` | Read-only fixed viewport query returned 213 by 63 under both locale-free and UTF-8 environments |
| Public native status | Ordinary idle inspection at 91 by 29 observed the exact session on both physical CLI versions |

The final Herdr turn is `01a0f17a-f838-7562-9c4a-dfc619c1d386`, with final marker
`AKK159_HERDR_ROUTING_a22752f7`. The final 0.159.2 async-answer turn is
`01a0f17a-cb8d-7b01-ad28-b3f3caa480fe`, with marker
`AKK1592_TMUX_ROUTING_efe316c1`. The separate running-task manual-Watch turn is
`01a0f17d-5f58-7dc2-8d5b-c3805d5e8aad`, with marker
`AKK1592_TMUX_ROUTING_427687aa`; both exact completion callbacks passed after additional
reconciliation without duplicates.

One concurrent-output boundary remains: if fresh assistant text appears after
the status card during a binding probe, the closed-card parser rejects that
frame. A manual Watch then reports `terminal_activity` / `best_effort` explicitly;
it must not be counted as an exact completion. Once output settles, a new,
separately guarded status probe can bind the active task. The final tmux async
scenario encountered this boundary for its extra manual Watch; its Send-created
exact Watch still confirmed the answer and exact marker completion. The activity
Watch's independent idle event is excluded from that result. No automatic answer
retry or permissive parsing of intervening assistant prose was introduced.

Earlier native attempts deliberately remain failed evidence: missing overlap,
unsupported history keys, changing history chrome, and delayed receipt exposed
the corrections above. A previous answer recorded after the old five-second
window was never replayed. Attempts ending without an answer are not successful
question tests, even when the daemon reports the turn completed.

At the close of the compatibility work, the original working directory's 34
dirty/untracked files, shell startup files, and Claude settings retained their
pre-task hashes. The CLI upgrades were installed. AKK code was initially kept
in the isolated compatibility worktree. Only the two owned Codex test tmux
servers were stopped after completion, with their socket, sole pane, workspace,
PID, and birth revalidated. The designated Herdr process retained its original
91 by 29 viewport. A later user-authorized local installation updated the
standalone CLI, plugin, and Skill to this exact runtime, restarted only the
Gateway, and passed `agent-knock-knock doctor --timeout-ms 60000`. The user
reported successful manual testing before authorizing publication.


## Publication gate for 0.13.14

After the user's successful local test and explicit publication authorization,
`npm run test:release` passed on 2026-10-01:

- Full suite: **2,851 passed**, zero failures, cancellations, or skips.
- Isolated OpenClaw 2026.9.1: install, runtime loading, callback, Doctor, bundled
  Skill, tmux fixture/diagnostics, update/reinstall, and uninstall passed.
- ClawHub Plugin Inspector runtime validation: **PASS**, with the real SDK.
- ClawHub publish dry-run: passed with the `herdr` topic retained.

The first full run exposed seven old TAB-separated tmux viewport fixture
responses across four test helpers, causing eleven failures. Those fixtures now
return the requested ASCII `x` format and assert the exact format argument;
negative malformed-viewport and native input safety assertions remain intact.
The final run above includes those corrections. Production runtime and Skill
hashes remained identical to the native-tested and user-tested candidate above.
No additional credentialed native lifecycle smoke was run; the existing actual
native observations and their limitations remain the evidence for that scope.

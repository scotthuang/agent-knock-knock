# Claude Code 2.1.285 compatibility

This working-tree adapter targets native Claude Code `2.1.285` on macOS arm64.
On 2026-09-30, Anthropic's release endpoints and npm dist-tags reported `latest`
as `2.1.285` and the delayed `stable` channel as `2.1.280`. The local installation
was upgraded from `2.1.282` to `2.1.285`, retaining its existing `latest` channel,
native installer, custom API proxy, authentication, and settings. See the
[official setup documentation](https://code.claude.com/docs/en/setup) and
[2.1.285 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.285).
This compatibility change is included in AKK 0.13.14. The observations below
describe its initial local validation; publication checks for the combined
candidate are recorded in the Codex 0.159.2 report.

## Adapter changes

- Register exact `2.1.285` lifecycle, status, question, and model-control profiles.
  Other versions retain their existing compatibility levels and runtime checks.
- Recognize the native named-session Composer border and the settled manual-mode
  footer without shortcut hints. The session title is display decoration; native
  UUID, process incarnation, workspace, and terminal fences still prove identity.
  Unknown overlays and malformed or incomplete Composer frames remain blocked.
- Recognize a named-session border following the complete native question footer.
  The title never contributes to question identity; truncated or ambiguous panels
  still cannot authorize a response.
- Treat the observed `agents` state `waiting` / `input needed` as potentially
  active when creating a Watch. Exact unfinished transcript ancestry is still
  required before binding the task.
- Recognize the observed Bash ask-rule permission dialog with only `Yes` and
  `No`. It must contain the complete Bash heading and rule explanation. Only
  one-time approval is supported, with the existing managed-task authority checks.
- Read attachment records that Claude writes physically before their parent
  prompt or another attachment. Only attachments are reordered along their UUID
  parent chain; conversational records retain physical order. Duplicate UUIDs,
  cycles, missing parents, unrelated branches, and mismatched identity still fail
  closed. Incremental observation starts early enough to retain those attachments
  while binding the exact user prompt. Store and Watch schemas are unchanged.

The Bash two-option prompt was observed with a session-scoped `Bash` ask rule.
It is not inferred from a truncated legacy three-option prompt. New cross-directory
Read prompts do not inherit this approval permission.

## Verification scope

Observations use isolated owned tmux sessions, a private AKK Store, and the
installed native executable. The existing custom API endpoint supplies the
`deepseek-flash` model configured on this machine; these observations do not establish first-party Anthropic
model or Remote Control compatibility. No existing Herdr work session is stopped
or restarted. Callback delivery is captured locally rather than sent to a user
chat channel.

The native CLI discovers the exact owned Claude process, version, workspace,
and session UUID. A closed AKK `/status` transaction parses that identity and
returns to the empty Composer. AKK Send accepts one exact prompt, observes its
final text, and delivers one local completion callback; a second reconciliation
does not duplicate it. Native new-thread, history listing, and exact resume back
to that completed session commit successfully without creating a model Turn.

The separate UI observations cover single-select Yes/No, a session-scoped Bash
ask-rule prompt approved once for a harmless `printf`, and selecting the already
current model with the session-only `s` action. Those UI key observations alone
do not prove the AKK response transaction or managed approval lifecycle.

The final named-session question scenario used the compiled production Send,
Watch, interaction-response, and transcript components with real native I/O and
a local callback collector:

| Scenario | Observed result |
| --- | --- |
| Explicit Send | One request injection and Enter; exact native prompt acceptance |
| Question notification | One `interaction_required` event with the exact question identity |
| AKK single-select response | Current advertised Yes option submitted once; response aggregate consumed |
| Watch added while that question was pending | Exact active prompt bound, including attachments physically preceding the prompt |
| Completion | Correct final text and one completion callback for each of the two Watches |
| Repeated reconciliation | No duplicate question or completion events |

There were six accepted model-task attempts in total: two isolated UI tasks, an
earlier task exposing the attachment-order failure, one successful simple
Send/completion task, a diagnostic question task, and the final question task
above. Two earlier draft-clear attempts stopped before submitting a model task.
The diagnostic question also exposed the named-footer and `input needed` gaps;
its response attempt later stopped before input because the temporary observer
had lost non-enumerable terminal endpoint identity during JSON serialization.
That task was answered manually in its owned pane. The final observation used
fresh canonical endpoint evidence and a fresh task/Watch; no stored identity was
rewritten to make the old response pass.

The validation counts, runtime hash, and Skill hash below describe the original
standalone Claude compatibility candidate. They are not evidence for the later
combined Claude 2.1.285 and Codex 0.159.2 candidate. Combined validation is recorded
separately in the [Codex 0.159.2 compatibility report](./codex-0.159.2-compatibility.md).

Validation on 2026-09-30:

- `npm run test:fast`: **2,236 passed**, zero failures, cancellations, or skips.
- TypeScript compilation and canonical Skill replica checks: passed as part of
  the fast-tier build.
- Architecture and refactor-evidence validators: passed. The transcript provider
  remains within its existing 3,534-line limit; attachment ordering is a pure
  helper in the same ownership domain.
- Original working-directory changes: all 34 previously dirty/untracked files
  retained their hashes. Shell startup files and Claude settings also retained
  their hashes. Only owned probe sessions were deliberately stopped.

The final observed runtime has 237 JavaScript files under `dist/src`. SHA-256 is
`c48a023da45c27fd76bab1f068e9f81fde6bfe89d77c57cb7e1a9a77c1e8ce31`, over sorted
relative paths followed by NUL, file content, and NUL. The canonical Skill hash is
`7f303633782cfca4c8955cb406f27cb4d30f88f9b5b11db837bbffef440aaed1`.
These local observations are not a full package-release attestation.

## Remaining boundaries

The native question observation covers a single-select Yes/No question. Native
multi-select and custom text answers, cross-directory Read approval, changing to
a different model/provider, the diagnostics warning panel, the complete managed
approval/callback lifecycle, and real external notification delivery are not
covered by this observation. Existing fast regressions remain distinct from native evidence. Unrecognized interaction shapes
retain manual handling rather than gaining authority through version matching.

A pre-existing explicit-Send issue was also observed in this compatibility run:
Claude automatically restored its `C-s` stash on request submission, including
AKK's draft-replacement sentinel. This left ` [AKK replacing current draft]` in
the Composer after successful Send and callback and could block subsequent
operations that require an empty Composer. The same native behavior exists in
2.1.266 and 2.1.282. The original compatibility change did not redesign that
clearing transaction. The lifecycle observations above start with an empty
Composer after explicitly clearing only the owned probe's sentinel; they do not
prove automatic recovery from this residue.

Local preview `0.16.1-list-guidance.3` changes the Claude physical-input clearing
transaction entirely before task text or Enter. A unique marker and the first
`C-s` prove an empty Composer; the second `C-s` must restore that same marker to
prove the one-entry stash has been popped and consumed. Bounded `C-u`/`C-k`
clearing then proves the Composer empty again with no hidden stash remaining.
An unproven step stops without task text or Enter. There is no post-Enter
Composer observation or cleanup and no interruption of a running task, so this
does not asynchronously erase text entered after submission. Ordinary managed
Sends, Codex and independent Watch monitoring are unchanged. This documents the
local fix; it does not claim a new live validation result for this preview.

Full, integration, and release suites were excluded from the initial local
task under `AGENTS.md`. After the user successfully tested the installed
combined candidate and authorized publication, the standard release gate was
run separately; see the Codex 0.159.2 report.

### Claude 2.1.295 physical footer compatibility

The native footer can show shell counts, `esc to interrupt`, `↓ to manage`,
and a right-aligned `Debug` label after `← for agents`. Physical Send accepts
only recognized native components, including wrapped rows and a separate
right-aligned stash indicator; unknown footer text still blocks before input.
A stash indicator is recognized as native footer syntax but blocks physical Send before input. `Draft restored` is a separate transient notification; an accompanying `› stashed` still reports a populated slot. The label is not proof of what the stash contains.

A shell count does not establish that Claude's foreground turn is idle.
Physical Send checks the foreground evidence independently and rejects a
running or unproven foreground turn. It also preserves an existing user draft:
the user must send, save, or clear it before a new physical Send. A completed
foreground turn with background shells and an empty recognized Composer can
remain eligible. These checks apply before task text; there is no Composer
observation, cleanup, or delivery veto after Enter.


### Existing-stash refusal in local preview .5

Claude physical-input preparation finishes before task text or Enter. A visible `› stashed` indicator refuses the attempt before any terminal input. When no stash is shown, AKK rechecks the empty main Composer and uses `C-s` once to restore any hidden stash. If content appears, it stops and leaves that content in the input box for the user; it does not re-stash or delete it. If the probe or final empty check is uncertain, it stops without task text or Enter and does not retry the key. This replaces the former sentinel transaction: no new marker is written and no editing keys delete a draft. There is no Composer observation or cleanup after task text or Enter. Ordinary managed Sends, Codex clearing and independent Watch monitoring are unchanged. This is refusal with manual recovery, not a guarantee of protecting drafts against simultaneous human input; avoid typing in the pane during an attempt. Screen capture and key delivery are not an atomic keyboard lock. A transport acknowledgement cannot prove that Claude processed `Ctrl+S`; ignored keys or cropped native indicators can leave stash occupancy unproven. AKK does not overwrite that unknown slot with a marker.

If List or Send reports a stashed draft, open that exact window and wait for the foreground turn to finish. Preserve any visible draft first. With the main input box empty, press `Ctrl+S` once to restore the stash, then save, send, or clear it yourself before refreshing List. AKK cannot identify hidden content just from the stash label. If restoration reveals `[AKK replacing current draft ...]`, it may be residue from an older failed AKK cleanup: remove only that marker after checking the text, preserve any other content, and do not press Enter on the marker. `Draft restored` is a transient restore notification; an accompanying `› stashed` still reports an occupied slot and remains a refusal condition. Do not repeatedly toggle `Ctrl+S` or retry an uncertain AKK attempt automatically.


### Shared notification-row correction in local preview .6

The .5 validation covered separate stash-badge rows, but a later native
2.1.295 observation showed the badge appended to another notification immediately
above the Composer:

```text
new task? /clear to save 337.6k tokens · › stashed
────────────────────────────────────────────────
❯
────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
```

The whole-line badge matcher in .5 missed that occupied stash. Its passing fast
suite and prior live checks were insufficient for this real layout. Local
preview .6 matches the badge at the end of the nearest notification row above
the current Composer, or at the end of a trailing row, rather than requiring
that the badge occupy the whole row. `Draft restored · new task? /clear to save
337.6k tokens · › stashed` also refuses before input. The `/clear` hint without a
badge does not itself block Send; foreground, input-ownership and closed-footer
checks remain independent. Earlier history rows are not treated as current
stash evidence when a newer reply intervenes.

Action contract 35 and projection v4 remain unchanged: this is an implementation
fix for the already documented no-stash precondition. It does not remove the
concurrent-input or native-key acknowledgement limits described above. The
new local package requires fresh native stash-and-restore verification; a
synthetic fixture alone is not evidence of a successful live check.

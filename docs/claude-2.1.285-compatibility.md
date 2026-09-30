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

A pre-existing explicit-Send issue was also observed: Claude automatically
restores its `C-s` stash on request submission, including AKK's draft-replacement
sentinel. This can leave ` [AKK replacing current draft]` in the Composer after
successful Send and callback. It can block subsequent operations that require an
empty Composer until the user clears the draft. The same native behavior exists
in 2.1.266 and 2.1.282. This change does not redesign that clearing transaction or
attempt asynchronous cleanup, which could erase newly entered user text. The
lifecycle observations above start with an empty Composer after explicitly
clearing only the owned probe's sentinel; they do not prove automatic recovery
from this residue.

Full, integration, and release suites were excluded from the initial local
task under `AGENTS.md`. After the user successfully tested the installed
combined candidate and authorized publication, the standard release gate was
run separately; see the Codex 0.159.2 report.

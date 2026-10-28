# Codex CLI 0.165.0 compatibility

AKK **0.16.4** includes this compatibility update, with coordinated Pi
**0.1.0-poc.12** and DeepSeek Harness **0.1.0-rc.15** dependencies. Publication
does not update existing local installations. The reviewed native combination
is **macOS Codex CLI 0.165.0 with app-server 0.165.0**. This is a tested
combination, not a numeric minimum for [direct control](codex-cli-native-compatibility.md).

## Frontend identity and local folder trust

A shared app-server can serve older CLI frontends. AKK preserves
`backend_version` and reports `agent_version` only from a uniquely and exactly
associated terminal. A thread's saved `cliVersion`, a matching directory or the
newly installed binary is not proof of its current frontend version.

The native `Folder access` / `Trust this folder?` screen is a persistent trust
decision: allowing it can enable project settings that run code. The dialog
already exists in the official 0.164.0 source; upgrading exposed an existing
recognition gap. AKK now reports it as blocked, without offering an ordinary
command-approval action. The user must decide in the original CLI. When the
frontend is exactly associated, List and Send retain that local boundary even
if the backend reports idle. Send rechecks it before dispatch; no task is
submitted to bypass the dialog. This does not infer a frontend association
from a shared directory or block unrelated backend conversations.

## Native terminal surfaces

The reviewed status, model, permission, blocking-question and asynchronous
question profiles add 0.165.0. The contextual single-row footer and explicit
`GPT-6.1-Sol xhigh fast` / `GPT-6-Astra max fast` / `GPT-6-Astra ultra fast`
labels remain distinct from task activity. An empty footer alone never proves
that the task is idle, and an unset `default` effort is not converted to `low`.

The model menu includes `GPT-6.1 Terra`, whose space previously caused AKK to
reject the entire menu. Its exact mapping to `gpt-6.1-terra` was checked against
the real native `model/list` response. The picker, effort header and idle
footer now share that explicit meaning; unknown spaced labels remain
unproven. Navigation uses current native row indices, not fixed model positions:
the live catalog moved Terra from row 6 to row 3 during the check.

A centered Full Access confirmation can cover an ordinary `• Model changed`
transcript row. AKK accepts that observed single-column bullet when locating
the exact 72-column styled rectangle. Unknown-width prefixes, changed warnings,
missing choices and stale frames still cannot authorize input. The real
confirmation was opened and cancelled without enabling Full Access.

Terminal paginated interaction writes add the audited **0.165.0/0.165.0** pair.
An older 0.162.1 or 0.164.0 frontend with backend 0.165.0 does not inherit its
terminal answer authority. Direct-backend operations validate their live
methods and structures independently. The asynchronous-question adapter retains
the 0.164 plain-title restriction: unsupported Markdown or ambiguous rendered
titles cannot be discarded to prove another pending question's identity.

## Protocol comparison

Official binaries generated **904 → 906** experimental TypeScript schema
files: eight changed, two added and none removed. All **34 selected schemas**
used by AKK for initialization, thread identity/history, turns/items, settings,
model metadata and interaction responses are byte-identical. The changes add
thread attachment/sample fields, memory reads, a network-review field, a Google
provider account variant and `modelNotFound`; AKK does not claim new operations
from those additions.

The **13 selected TUI source files** covering status, model and permission
menus, composer/footer, blocking/async questions and folder trust are also
byte-identical across the two tags. The model catalog snapshot adds Terra;
startup/backend selection and command-center/history changes are reviewed
separately. Schema/source agreement is compatibility evidence, not proof that
an actual task completed.

## Verification boundaries

Dedicated CLI processes used the existing proxy wrapper, private Codex homes,
isolated workspaces and private AKK storage. User work sessions, shared backend,
Gateway and Desktop were not restarted. The native harness uses AKK's public
CLI dispatcher, native runtime, Store, response service and callback outbox;
a local receiver replaces external messaging and monitoring is reconciled in
the harness process. This is not a new independent-monitor-process or WeChat
end-to-end result.

| Check | Evidence and result |
| --- | --- |
| Native Send, Status and exact Watch | Two real tasks in one dedicated frontend/backend pair completed through the public CLI dispatcher, including the first task before materialized history. Each produced one local completion receipt. |
| Public progress and task isolation | Active public commentary and bounded tool progress were observed within the 800-code-point budget. An old Watch retained its original native turn after the next task began. |
| Deadlines and duplicate suppression | Actual default monitoring deadline was 720 minutes. Repeated Send retained its original receipt/turn; observer reconnection and repeated observations did not duplicate completion receipts. |
| Native permissions | Public permission options and Read Only/Default round trips confirmed effective values. The private launch began with custom read-only settings and no profile ID; the check left an explicit restrictive Read Only profile. This is not byte-identical restoration of that initial custom setting. |
| Native command approval | A real request matched the exact thread, turn and fixture command. Public approve-once caused exactly one harmless file append; repeating the response caused no reexecution and one local completion receipt. |
| Native blocking question | A native Plan-mode task produced a real single-choice question. Public Watch/Status/Respond bound the exact request and answer; completion confirmed the selected value. Repeating the answer retained one response attempt and one local completion receipt. Native Plan setup is not proof of an AKK Plan-mode setter. |
| Native terminal menus | Session-only Sol xhigh fast, Astra max/ultra fast and Terra low switches were exercised, followed by restoration to Sol low with priority service off. Production parsers accepted 14 real captures, including native status with an exact visible UUID and redacted account, styled slash popup, model/effort values and permission surfaces. This is native UI exercise plus parser verification, not a complete AKK terminal transaction. |
| Folder-trust guard and mixed versions | Real isolated trust captures and deterministic regressions cover blocked status, zero-input rejection, exact alias isolation, and frontend/backend version separation. No user business trust dialog was answered. |
| Retained clients and malformed surfaces | Regression coverage retains older profiles, unknown/mixed terminal pairs, styled-composer/permission guards, dynamic model indices, Markdown ambiguity and unknown labels. This does not claim fresh old-version live sessions. |

The final development and publication commands and their actual counts are
recorded in the release PR. Publication requires the full `npm run test:release`
gate, type checking, architecture validation and package-content checks. A
passing local callback receiver proves acceptance at that receiver, not
OpenClaw/WeChat delivery.

## Retained limits

- Native CLI new/clear/resume lifecycle controls remain unavailable for these
  paginated versions. A loaded thread is not permission to launch a replacement.
- CLI model changes and cancellation still need eligible terminal operations;
  this release does not invent backend setters or cancellation authority.
- Folder trust has no automated allow/deny action. Local trust and command
  approvals are different decisions.
- Async-question rendering is covered by source review and deterministic
  regressions, not a new real async-question run. Command approval evidence does
  not establish a new file-patch/rejection matrix.
- Old persisted deadlines, managed-terminal 60-minute inactivity behavior,
  notification receipts and uncertain-input rules are unchanged. Replaying Send
  returns the original receipt; it does not renew monitoring or reexecute work.
- No new Desktop, Linux, Windows, Pi live-model, DSH live-model or external
  messaging delivery claim is made.

## Sources

- [Official 0.165.0 release](https://github.com/openai/codex/releases/tag/rust-v0.165.0), published 2026-10-27 at 20:09:38 UTC.
- [Official 0.164.0…0.165.0 comparison](https://github.com/openai/codex/compare/rust-v0.164.0...rust-v0.165.0).
- [Official model menu implementation](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/chatwidget/model_popups.rs).
- [Official folder-trust implementation](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/onboarding/trust_directory.rs).
- [Previous 0.164.0 review and retained limits](codex-0.164.0-compatibility.md).

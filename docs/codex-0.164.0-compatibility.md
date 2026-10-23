# Codex CLI 0.164.0 compatibility

AKK 0.14.17 includes this compatibility update. Publishing the package does not
upgrade an existing local installation. The reviewed combination is
macOS Codex CLI **0.164.0** with app-server **0.164.0**. It is a tested
combination, not a numeric minimum for [direct control](codex-cli-native-compatibility.md).

## Terminal changes

The real 0.164.0 terminal can show `GPT-6.1-Sol default` in its model footer.
It can also put the model, directory and warning on one contextual footer row,
without a separate `? for shortcuts` row. The previous closed composer grammar
rejected these surfaces, preventing native status or controls even when the
original session was idle.

The adapter recognizes the observed `default` label and the version-specific
single-row composer layout. The label does **not** prove an effective reasoning
effort such as `low`. Process, pane, native-thread, styled empty-input, approval,
busy-state and input-ownership checks remain necessary before terminal input.
An accepted footer alone does not prove that a task is idle.

The centered Full Access confirmation can overlap this footer. Its geometry
parser now accepts the observed single-column `›`, `»` and `·` background
glyphs; it still requires the exact styled rectangle, warning and choices.

Asynchronous question titles are now rendered as Markdown. The terminal
adapter accepts only single-line plain titles whose rendering is provably
unchanged, against the full native question identity. If any candidate contains
Markdown-sensitive syntax, a character reference or a line break, the expanded
surface remains ambiguous; it cannot be discarded to select another question.
Two requests with the same visible title also remain unproven. These terminal
restrictions do not apply to the backend's structured question response.

The status, model, permission and question profiles are reviewed separately.
Terminal paginated interaction writes add the audited **0.164.0/0.164.0** pair;
other existing pairs retain their own checks. Unknown or mixed versions do not
inherit this pair's terminal write authority. Direct-backend controls continue
to validate live methods and response contracts independently of that table.

## Native protocol

Official binaries generated 888 experimental TypeScript schema files for
0.162.1 and 904 for 0.164.0: 24 changed, 16 added and none removed. The 30
reviewed schemas used by AKK for initialization, native identity, paged history,
subscription, settings, interactions and responses are byte-identical.

`ThreadReadResponse.readState` is additive relative to 0.162.1 and was already
present in 0.163.0. It records reading position, not task execution, acceptance
or completion. Regression coverage verifies that an all-read marker or an
unread marker for another turn cannot change the exact selected task.
`turn/start` and `turn/steer` add optional `responsesapiClientMetadataPatch`;
AKK's existing requests remain valid without that field.

Upstream now preserves saved settings during resume. AKK's existing loaded
thread subscription sends only `threadId` and `excludeTurns`, without overriding
model, sandbox or service tier. No backend parser or request workaround was
needed for these changes. Schema agreement is separate from live validation.

## Verification boundaries

Live checks use dedicated CLI processes launched through the existing proxy
wrapper, private Codex homes and isolated AKK storage. User work sessions,
Gateway, Desktop and the shared production daemon are not restarted. A local
callback receipt proves acceptance only at that receiver, not delivery to
OpenClaw or WeChat.

The backend harness uses the production public CLI dispatcher, native runtime,
Store, response service and callback outbox. It substitutes a local receiver
and performs reconciliation in the harness process. It does not establish a
new independent-monitor-process or messaging-channel end-to-end result.

| Check | Evidence and result |
| --- | --- |
| Installed backend read contract | Read-only initialization and reads succeeded for all 13 loaded threads observed at the time. This is read evidence, not 13 independent task or Send verifications. |
| Native Send and exact Watch | Two real tasks in one dedicated CLI/backend pair completed through AKK's public CLI dispatcher. The first started with no materialized history. Each produced one local completion receipt. |
| Public progress and task isolation | Captured public commentary and a bounded tool-status summary while active. The old Watch kept its original turn when the next task started. |
| Monitoring and idempotency | Actual default deadline was 720 minutes. Repeated Send kept the original receipt and native turn; observer reconnection and repeated reads did not duplicate completion notifications. |
| Native permission settings | Public permission options and Default/Read Only round trips confirmed effective settings. The isolated launch initially had custom read-only settings without a profile ID; the check established the explicit Read Only profile and left it restrictive before cleanup. It did not claim byte-identical restoration of that private initial setting. |
| Native command approval | A real pending approval was matched to its exact thread, turn and fixture command. Public approve-once caused exactly one file append and one completion receipt; repeating the same response did not execute it again. |
| Native blocking question | A dedicated native Plan-mode turn produced one real single-choice request. AKK's public Watch, Status and Respond operations selected the exact opaque question/option IDs; the final answer confirmed the selection and one local completion receipt. Repeating the response retained one dispatch. Native setup is not evidence of an AKK Plan-mode setter. |
| Terminal status/model/permissions | Exercised the real native menus in a separate private CLI, including session-only High effort and Full Access followed by restoration to Read Only. The built AKK parsers accepted the saved exact status, styled popups, model/effort menus and permission confirmation; they rejected the history viewer. This is native UI exercise plus production-parser replay, **not** a full AKK terminal transaction end-to-end result. |
| Development gates | Final `npm run test:fast`: **3,099 passed, zero failures**. `npm run typecheck`, `npm run build`, `npm run validate:architecture`, Skill consistency and `git diff --check` passed. |
| Cleanup | Both dedicated frontends and their private backend/tmux hosts stopped; copied authentication files and owned sockets removed. Existing user processes and installed AKK were unchanged. |

The asynchronous-question rendering change is supported by official source
review and synthetic regressions, not a new live asynchronous-question run.
The live approval check covers one command approval; it does not add a new
file-patch approval or rejection matrix.

The formal publication gate runs `npm run test:release` (connector checks, full
regressions, isolated OpenClaw compatibility and ClawHub validation/dry-run),
type checking, architecture validation and package-content checks. Its actual
results are recorded in the release PR, separately from the development and
live evidence above. No new external-channel delivery is implied by that gate.

## Retained limits

- CLI native new/clear/resume lifecycle controls remain unavailable for these
  paginated versions. Discovering a loaded thread is not permission to cold-load
  another process or substitute a conversation.
- Direct CLI model changes and cancellation still require an eligible terminal
  route; a version profile does not add backend methods to AKK.
- When the terminal reports only `default` effort, AKK cannot prove the current
  effective effort from that footer. Model catalog/control can still reject
  this ambiguous state. The adapter does not silently turn `default` into `low`.
- Public progress keeps its 800-code-point, redacted, grapheme-safe budget and
  exact turn. Read receipts, idle state and partial answers are not completion
  authority.
- Monitoring retains the shared 720-minute hard deadline, managed-terminal
  60-minute inactivity window, immutable existing deadlines and notification
  deduplication. Replaying Send returns its original receipt; use Status for
  current acceptance and completion evidence.
- No new Desktop, Linux or Windows live compatibility claim is made. Previously
  supported CLI versions are retained through regression and source evidence,
  not new old-version live sessions.

## Sources

- [Official 0.164.0 release](https://github.com/openai/codex/releases/tag/rust-v0.164.0), published 2026-10-23.
- [Official app-server protocol](https://learn.chatgpt.com/docs/app-server#protocol).
- [Saved settings during resume](https://github.com/openai/codex/pull/55923).
- [Earlier 0.162.1 operation matrix](codex-0.162.1-compatibility.md#verification-record).

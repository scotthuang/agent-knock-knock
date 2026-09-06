# Interactive terminal response design

Status: local POC implemented; not a published package contract

## Problem

AKK's terminal approval boundary historically exposes one operation: approve
the adapter-proven first, one-time `Yes` choice. `cancel` interrupts the Turn;
it is not a semantic `No` selection. Modern Claude Code and Codex TUI surfaces
also ask ordinary questions with choices, optional free-form input, multiple
steps, and a final confirmation. Treating every such surface as approval would
conflate permission authority with task input and would make safe replay and
auditing impossible.

This design therefore keeps two boundaries:

- **Permission decision**: a closed adapter-owned decision such as
  `approve_once` or `reject`. Persistent authorization choices are never
  offered. The caller never supplies terminal keys, menu indexes, or labels.
- **Questionnaire response**: a versioned public projection containing opaque
  question and option ids, plus typed answers. The terminal key plan and all
  mutation authority remain owner-private.

## Public model-facing contract

AKK projects one currently visible interaction:

```json
{
  "schema": "agent-knock-knock/terminal-interaction",
  "version": 1,
  "interaction_id": "opaque-id",
  "turn_id": "turn-...",
  "agent": "claude",
  "kind": "questionnaire",
  "state": "pending",
  "step": { "index": 1, "total": 2 },
  "questions": [
    {
      "question_id": "opaque-question-id",
      "header": "Color",
      "prompt": "Which color do you prefer?",
      "required": true,
      "response_kind": "single_select",
      "options": [
        { "option_id": "opaque-red-id", "label": "Red" },
        { "option_id": "opaque-blue-id", "label": "Blue" }
      ]
    }
  ],
  "capabilities": {
    "batch_response": false,
    "free_text": false,
    "multi_select": false
  }
}
```

The corresponding mutation accepts only the advertised semantic ids and typed
answer shape:

```json
{
  "interaction_id": "opaque-id",
  "turn_id": "turn-...",
  "answers": [
    {
      "question_id": "opaque-question-id",
      "response_kind": "single_select",
      "selected_option_ids": ["opaque-blue-id"]
    }
  ]
}
```

The OpenClaw tool should be named
`agent_knock_knock_respond_interaction`. It is deliberately separate from
ordinary `respond({turn_id, request})`, which injects a new composer message,
and from `approve({turn_id, decision})`, which resolves a permission prompt.

The first local implementation is step-oriented: one response call resolves
only the currently projected step. AKK recaptures the next native question and
publishes a new `interaction_id`. This makes multi-question and final-confirm
flows explicit and avoids a blind batch of terminal input.

## Private authority

The Store may retain a private authority record binding all of the following:

- exact Turn and owning OpenClaw session;
- terminal endpoint, process incarnation, native thread, and binding
  generation;
- transcript/rollout source identity and bounded observation point when
  available;
- an exact unredacted prompt-region fingerprint;
- the current native step and the adapter-owned semantic-id-to-input plan;
- expiry, reservation, last proven stage, and uncertain-outcome state.

None of those mutation fields are copied into the public projection. Labels
and redacted excerpts are presentation only and never mutation authority.

## Recognition and dispatch

Every supported surface has a closed adapter/version profile. Detection must
isolate one bottom-most complete prompt, prove its footer and frame, reject
duplicate/out-of-order choices, and produce a digest before redaction.

For each response AKK:

1. acquires terminal, Store-writer, and Turn-state locks in canonical order;
2. revalidates owner, Turn status, binding generation, process/native identity,
   expiry, and the current private interaction offer;
3. recaptures the screen and requires the same exact prompt fingerprint;
4. resolves opaque semantic ids to an adapter-owned input plan;
5. reserves the response durably before possible terminal input;
6. dispatches one bounded native step;
7. records an audit receipt without raw answer content and resumes the monitor;
   and
8. recaptures the next native state on Status, which rotates the interaction
   id because the exact prompt fingerprint changed.

If a failure occurs before terminal input, the response is safely rejected.
If input may have occurred, the Turn becomes `response_uncertain`; AKK sends no
automatic retry. Unknown versions, secret-input questions, ambiguous screens,
unsupported option counts, changed prompts, or unprovable postconditions are
`manual_required` and send zero input.

## Native behavior profiles

### Claude Code 2.1.263

Observed locally in an isolated tmux session:

- single-select: digit selects and advances/submits;
- multi-select: digits toggle checkboxes, then `Tab` advances to review;
- Other/free text: select `Type something`, enter text, then Enter;
- multi-question: a tab header shows checked/unanswered sections;
- final review: `Submit answers` / `Cancel` is a distinct confirmation step;
- Bash permission prompt: the exact four-row form has one-time Yes as the
  current row and `4. No`; `Escape` cancels the dialog and is not modeled as
  semantic reject.

The local POC executes exact single-select rows (including the transition into
`Type something`), the recaptured single-line custom-text editor, and the
separate final Submit/Cancel review. It detects multi-select screens but keeps
them `manual_required`: safely toggling several checkboxes requires a
recapture after every toggle and is intentionally deferred. `Tab to amend`,
persistent Yes, auto mode, resized/wrapped variants, and any changed menu shape
also remain manual.

### Codex 0.153.4

The installed client matches the current official TUI protocol:

- `RequestUserInput` contains 1-3 questions with 2-3 options and automatic
  Other;
- numeric selection advances a choice question;
- optional notes/free-form answers use the composer;
- the exact multi-question free-form footer is handled one current step at a
  time;
- unanswered-question confirmation is its own `Proceed` / `Go back` step.

Codex does not currently expose a native multi-select question in this
protocol. Any future or unrecognized shape remains manual until a new profile
and tests are added.

## Delivery stages

1. **Permission parity (implemented locally)**: expose `reject` only when an
   adapter proves an exact safe native reject action; retain `approve_once`
   compatibility.
2. **Read-only projection (implemented locally)**: detect and report supported
   questionnaire steps while changed or unsupported shapes remain manual.
3. **Local response POC (implemented locally)**: enable one current
   single-select, free-text, or confirmation step with pre-input fencing,
   durable one-shot reservation, and uncertain-result audit.
4. **Expanded native coverage (not implemented)**: multi-select, notes,
   navigation, and more
   version profiles only with captured fixtures and live regression evidence.
5. **Host-native UX**: OpenClaw may render the projection using a future public
   session-bound `requestUserInput` API. Until then, the structured AKK tool is
   the authority boundary; a plugin must not use private Gateway methods.

## Non-goals

- no raw tmux keys, numeric menu indexes, or arbitrary labels in public tools;
- no automatic permission decisions or persistent authorization grants;
- no secret/password response relay;
- no blind retry after possible input;
- no attempt to emulate an arbitrary terminal UI.

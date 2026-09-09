# Quick Start with Herdr

AKK supports local Herdr `0.8.0` (socket protocol 19) as a terminal provider alongside tmux. AKK does not start Herdr or a coding agent.

Install and open Herdr, then start Codex or Claude Code in a pane:

```bash
brew install herdr
herdr
```

Inside a Herdr pane, run one of:

```bash
codex --yolo
# or
claude
```

Wait for the empty idle composer. After the AKK OpenClaw plugin is installed and its Gateway restarted, use:

```text
/akk list
/akk inspect this repository and summarize it
```

AKK enumerates every running local Herdr session, identifies a terminal by its session socket plus stable `terminal_id`, and treats the current `pane_id` only as a refreshable route. Moving a live pane does not silently rebind ownership. Every side effect revalidates the terminal resource, shell PID, agent PID, cwd, native-session evidence, and current composer first.

The v25 structured model contract carries semantic IDs only. Ordinary send is `send({session_id,request})` for strict continuation or `send({terminal_id,request})` for the current verified Herdr pane; the targets are mutually exclusive. An advertised `terminal_user_explicit` action keeps the user's Send independent of broken AKK management state and Codex Composer visibility, stability, or exactness. It requires the exact live terminal/process plus a scanned, non-blocked approval state. Codex freezes the open-rollout candidate set, sends `C-u` once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto. A unique exact request acceptance promotes the provisional Session/Turn even when `/clear` delayed creation of the foreground rollout; zero or ambiguous matches never cause replay. Claude Code remains exact-empty-only. If managed promotion cannot be prepared before input, AKK still sends once, best-effort attaches an exact Terminal Watch, and releases stale management. That Watch can notify the controller of a questionnaire requiring manual TUI input but cannot answer it. Watch failure never changes delivery. Native inspection and lifecycle input remain exact-empty-only. Send results expose physical dispatch, agent acceptance, management, and observation separately. Watch and native/lifecycle actions likewise expose `terminal_id` (plus `inspection` or `native_thread_id` where applicable), never a pane route, selector, draft text, composer digest, token, fingerprint, revision, or binding generation. AKK resolves the current Herdr route and derives all opaque freshness fences privately, then revalidates them under lock before terminal input. Once the Codex mutation sequence begins, an uncertain result must not be retried automatically.

For a physically exact, exact-empty idle Codex pane with ambiguous rollout identity, a fresh row may advertise `identify_foreground` and `identify_and_send`. The diagnostic action changes no AKK Store record but sends `/status` exactly once through the same visible Herdr pane; its 30-second proof grants no later authority. The atomic action retains the canonical Herdr terminal lock across the probe and one task, while exact request acceptance remains the only durable Session/Turn identity. Ordinary Send, List, and Status never run the probe. The three status axes remain independent: `screen_state` describes the live TUI, `native_identity_state` describes foreground identity resolution, and `durable_activity_state` describes exact artifact-backed work; legacy `activity_state` stays conservative for compatibility.

To observe an exact Herdr Codex or Claude Code terminal without changing it, run a fresh `/akk list` and copy that row's complete `terminal_id`. Its advertised `watch` action is the recommended convenience, but missing advertisement does not veto an explicit user request. Both the structured action and `/akk watch <exact-terminal-id>` take only that exact ID. The result's `watch_id` is the sole target for `/akk status <watch-id>` and `/akk unwatch <watch-id>`.

Watch is read-only and follows the user's selected terminal. Coding-agent version or artifact uncertainty, missing binding metadata, managed ownership, and missing action advertisement are warnings rather than creation vetoes. AKK fails only when that exact Herdr terminal is absent, its endpoint/process cannot be identified, neither an exact durable task anchor nor a read-only screen-status path exists, or the durable Watch Store cannot be created. An existing managed monitor remains preferable for exact Turn attribution, but an explicit Watch can coexist without adopting or mutating it. A successful user-explicit unmanaged fallback may separately attach an automatic exact-request Watch after AKK sends; once the exact request is anchored, each distinct native questionnaire may emit one bounded `interaction_manual_required` callback with response authority disabled.

This creates an independent Terminal Watch schema-v2 record, not an AKK Session or Turn. The Watch sends no input and does not adopt, claim, reserve, block, interrupt, approve, answer questionnaires, or otherwise change the task. Approval observations are notification-only for manual Watches; questionnaire notification is limited to an automatic exact request-bound Watch created after `terminal_user_explicit` unmanaged fallback. Both must be resolved in the live TUI because Terminal Watch cannot auto-approve or call `respond_interaction`. AKK first tries a privacy-safe exact rollout/transcript task anchor (`watch_mode="exact_task"`, `confidence="exact"`). If none can be built, it records warnings and uses the exact Herdr terminal/process activity epoch (`watch_mode="terminal_activity"`, `confidence="best_effort"`): only after observing working or approval activity and then stable idle across consecutive sweeps does it emit a callback. That fallback callback proves only that observed terminal activity became idle, not that one exact task completed or succeeded. Exact-anchor identity/file/boundary drift still invalidates that exact Watch rather than following another task. Durable settlement and callback-outbox state let OpenClaw supervision recover and retry an idempotent notification after restart.

Herdr's raw `pane send-text` command is not used for task delivery. AKK uses the Unix-socket `pane.send_input` method so multiline text follows Herdr's bracketed-paste-aware path, persists the text-injected stage, resolves the stable terminal again, and then dispatches one separate Enter.

Current boundary:

- local Unix-domain sockets only;
- exact Herdr `0.8.0`, protocol 19;
- the Codex and Claude Code versions in the main compatibility matrix are regression-tested; other complete `x.y.z` versions use the generic runtime protocol with a warning;
- remote/SSH Herdr sessions and Windows named pipes are not yet supported;
- Herdr's agent status is diagnostic only—AKK's existing screen, transcript, rollout, and native identity fences remain authoritative.

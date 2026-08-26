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

The v23 structured model contract carries semantic IDs only. Ordinary send is `send({session_id,request})` for strict continuation or `send({terminal_id,request})` for the current verified Herdr pane; the targets are mutually exclusive. An advertised `terminal_user_explicit` action keeps the user's Send independent of broken AKK management state and Codex Composer visibility, stability, or exactness. It requires the exact live terminal/process plus a scanned, non-blocked approval state. Codex physical fallback sends `C-u` once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto; Claude Code remains exact-empty-only. AKK tries managed delivery where its strict empty-composer pre-input authority exists, then sends once without a managed callback Turn if that path failed before input. After Enter succeeds, it best-effort attaches an exact Terminal Watch callback and releases stale management. Watch failure never changes delivery. After user-explicit Codex text injection, the managed path also cannot use Composer observation to veto Enter. Native inspection and lifecycle input remain exact-empty-only. Watch and native/lifecycle actions likewise expose `terminal_id` (plus `inspection` or `native_thread_id` where applicable), never a pane route, selector, draft text, composer digest, token, fingerprint, revision, or binding generation. AKK resolves the current Herdr route and derives all opaque freshness fences privately, then revalidates them under lock before terminal input. Once the Codex mutation sequence begins, an uncertain result must not be retried automatically.

To observe a task that you started directly in the Herdr Codex or Claude Code TUI, wait until it is actively working or awaiting approval, run a fresh `/akk list`, and use only that terminal row's advertised `watch` action. Both the structured action and `/akk watch <exact-terminal-id>` take only that exact terminal ID; Watch resolves and revalidates current binding authority internally. The result's `watch_id` is the sole target for `/akk status <watch-id>` and `/akk unwatch <watch-id>`.

The manual Watch action is only for human-started external work. If the terminal already has an active AKK-managed Turn, list and status do not offer manual Watch and a direct Watch attempt is rejected; use that Turn's existing monitor, status, and callback path instead. A successful user-explicit unmanaged fallback may separately attach an automatic Watch for the exact request AKK sent.

This creates an independent Terminal Watch schema-v2 record, not an AKK Session or Turn. The Watch itself sends no input and does not adopt, claim, reserve, block, or interrupt the task. Manual-Watch approval is notification-only and must be decided in the live TUI; automatic fallback Watch emits no approval callback, and Terminal Watch cannot auto-approve. Its exact Herdr endpoint, process/native-task identity, and privacy-safe rollout or transcript anchor fail closed on any identity, file, boundary, or fingerprint drift. Durable settlement and callback-outbox state let OpenClaw supervision recover and retry an idempotent notification after restart.

Herdr's raw `pane send-text` command is not used for task delivery. AKK uses the Unix-socket `pane.send_input` method so multiline text follows Herdr's bracketed-paste-aware path, persists the text-injected stage, resolves the stable terminal again, and then dispatches one separate Enter.

Current boundary:

- local Unix-domain sockets only;
- exact Herdr `0.8.0`, protocol 19;
- the Codex and Claude Code versions in the main compatibility matrix are regression-tested; other complete `x.y.z` versions use the generic runtime protocol with a warning;
- remote/SSH Herdr sessions and Windows named pipes are not yet supported;
- Herdr's agent status is diagnostic only—AKK's existing screen, transcript, rollout, and native identity fences remain authoritative.

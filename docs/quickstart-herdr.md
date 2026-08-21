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

To observe a task that you started directly in the Herdr Codex or Claude Code TUI, wait until it is actively working or awaiting approval, run a fresh `/akk list`, and use only that terminal row's advertised `watch` action. A structured caller copies its exact `terminal_id` and `expected_binding_token`; the slash form copies the exact terminal ID into `/akk watch <exact-terminal-id>` and rechecks the current action. The result's `watch_id` is the sole target for `/akk status <watch-id>` and `/akk unwatch <watch-id>`.

This creates an independent Terminal Watch schema-v1 record, not an AKK Session or Turn. It sends no input and does not adopt, claim, reserve, block, or interrupt the human's task. Approval is notification-only and must be decided in the live TUI; Terminal Watch cannot auto-approve. Its exact Herdr endpoint, process/native-task identity, and privacy-safe rollout or transcript anchor fail closed on any identity, file, boundary, or fingerprint drift. Durable settlement and callback-outbox state let OpenClaw supervision recover and retry an idempotent notification after restart.

Herdr's raw `pane send-text` command is not used for task delivery. AKK uses the Unix-socket `pane.send_input` method so multiline text follows Herdr's bracketed-paste-aware path, persists the text-injected stage, resolves the stable terminal again, and then dispatches one separate Enter.

Current boundary:

- local Unix-domain sockets only;
- exact Herdr `0.8.0`, protocol 19;
- Codex and Claude Code versions listed in the main compatibility matrix;
- remote/SSH Herdr sessions and Windows named pipes are not yet supported;
- Herdr's agent status is diagnostic only—AKK's existing screen, transcript, rollout, and native identity fences remain authoritative.

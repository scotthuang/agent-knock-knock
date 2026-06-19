# Changelog

## Unreleased

### Added

- Added ACPX executor metadata so delegations can target Claude Code or Codex.
- Added CLI task management commands: `list`, `status`, `send`, and `close`.
- Added OpenClaw plugin tools for task listing, task status, follow-up sends, and local task close.
- Added the `/akk` OpenClaw command for direct delegation, task listing, status, follow-up sends, and task close from command-capable chat surfaces.
- Added manifest contracts and tool metadata for the new OpenClaw plugin tools.
- Added cooperative AKK cancellation through `agent-knock-knock cancel`, `agent_knock_knock_cancel`, and `/akk cancel <conversation-id>` for Codex and Claude ACPX sessions.
- Added Codex ACPX proxy and model configuration support for environments that require `ALL_PROXY` or a ChatGPT-compatible model id.
- Added lazy idle-timeout cleanup for idle AKK sessions, configurable with `idleTimeoutMinutes` and defaulting to 10080 minutes.
- Added runtime diagnostics logs under `~/.agent-knock-knock/logs`, with local timestamps, daily NDJSON files, secret redaction, log-level filtering, and retention cleanup.
- Added tests for Codex-backed delegation and task management flows.
- Added tests for runtime diagnostics logging, redaction, retention cleanup, and CLI log emission.

### Changed

- Changed actionable callback delivery from Gateway `sessions.send` to `chat.send` with `deliver: true`, so callbacks injected into channel-scoped OpenClaw sessions can use the original outbound channel route.
- Changed coding-agent `done` callbacks to move AKK conversations to `idle` instead of terminal `done`, allowing follow-up sends to continue the same session until manual close or idle timeout.
- Updated `done` callback messages to include concise AKK convenience commands such as `AKK list`, `AKK send <conversation-id>: <message>`, `AKK status`, and `AKK close`.
- Updated OpenClaw plugin routing descriptions so `AKK` and `akk` both indicate Agent Knock Knock, and unspecified AKK delegations default to Codex.
- Updated the OpenClaw skill template so follow-up language such as "continue", "再让它", or "给刚才那个" defaults to reusing the most recent matching open AKK session through `agent_knock_knock_send`.
- Updated the OpenClaw skill template with AKK cancel routing for stopping current in-flight work without closing the reusable AKK session.
- Updated the OpenClaw skill template with AKK/akk routing, default Codex delegation, Claude opt-in routing, and task management tool usage.
- Updated follow-up sends from OpenClaw to launch the coding agent in the background so OpenClaw can continue to subsequent tool calls.
- Updated documentation to describe local coding agents, task management, cooperative cancellation, and the home-directory conversation store.
- Documented ACPX approval behavior: Claude Code permission requests work with `--approve-all`, while some Codex sensitive operations can fail directly under AKK's non-interactive/background path instead of surfacing an approvable ACPX permission request.

### Fixed

- Fixed OpenClaw plugin delegations generating `--record-only` callback commands even when Gateway callback delivery was configured, which caused completed Codex tasks to be logged locally without returning results to OpenClaw.

### Verified

- `npm test` passes 42 tests.
- Local OpenClaw installation validated with the linked Agent Knock Knock plugin loaded, the updated `bidirectional-chat` skill installed, and the gateway restarted successfully.
- Live OpenClaw validation created a Claude task, listed Claude tasks, sent a follow-up message, and closed the task through plugin tools.
- Live OpenClaw validation created a Codex task with `ALL_PROXY=socks5h://127.0.0.1:1082` and `model=gpt-5.5/medium`, listed Codex tasks, sent a follow-up message, received Codex `done`, and closed the task through plugin tools.
- Live ACPX validation created smoke sessions for Codex and Claude Code, called AKK cancel for each, observed `executor_cancel_requested` events with status 0, and closed the smoke ACPX sessions.

## 0.1.0 - 2026-05-16

Initial MVP for managed bidirectional agent delegation.

### Added

- Added a minimal Node.js project with no runtime dependencies.
- Added structured bidirectional message protocol for OpenClaw manager and Claude Code developer roles.
- Added conversation state tracking with response-round budget support.
- Added budget thresholds:
  - 50 response-round soft limit
  - 100 response-round hard limit
  - 30-round convergence warning
  - 40-round completion/degrade/failure warning
- Added NDJSON event logging for conversations, messages, raw exchanges, and closure events.
- Added Claude Code bootstrap prompt generation.
- Added CLI commands for creating conversations, recording messages, generating bootstrap prompts, and delegating tasks.
- Added shell wrapper for delegation startup.
- Added OpenClaw skill template for bidirectional Claude Code delegation.
- Added protocol documentation.
- Added two-Claude simulation script for weather lookup and multi-round architecture decision scenarios.
- Added tests for response-round accounting, budget escalation, and done-message closure behavior.

### Verified

- `npm test` passes.
- Conversation creation writes state and NDJSON logs.
- Message recording updates conversation state.
- Two-Claude architecture scenario completes with correct round accounting:
  - `task`, `question`, `answer`, `question`, `answer` count as response rounds.
  - `done` does not increment response rounds.
- Two-Claude weather scenario records blocked/failure flows when live weather lookup is unavailable.

### Known Issues

- `blocked` handling was corrected after the first weather test; older logs may show `blocked` as `requires_response=false`.
- The two-Claude simulation currently stores full raw `acpx` output in logs, including client/tool status lines.
- The script does not yet parse the model's returned JSON into canonical message body fields.
- Real OpenClaw Gateway integration is not implemented yet; current implementation simulates OpenClaw with Manager Claude.

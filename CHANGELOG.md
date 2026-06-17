# Changelog

## Unreleased

### Added

- Added ACPX executor metadata so delegations can target Claude Code or Codex.
- Added CLI task management commands: `list`, `status`, `send`, and `close`.
- Added OpenClaw plugin tools for task listing, task status, follow-up sends, and local task close.
- Added manifest contracts and tool metadata for the new OpenClaw plugin tools.
- Added Codex ACPX proxy and model configuration support for environments that require `ALL_PROXY` or a ChatGPT-compatible model id.
- Added tests for Codex-backed delegation and task management flows.

### Changed

- Updated OpenClaw plugin routing descriptions so `AKK` and `akk` both indicate Agent Knock Knock, and unspecified AKK delegations default to Codex.
- Updated the OpenClaw skill template with AKK/akk routing, default Codex delegation, Claude opt-in routing, and task management tool usage.
- Updated follow-up sends from OpenClaw to launch the coding agent in the background so OpenClaw can continue to subsequent tool calls.
- Updated documentation to describe local coding agents, task management, and the home-directory conversation store.

### Verified

- `npm test` passes 35 tests.
- Local OpenClaw installation validated with the linked Agent Knock Knock plugin loaded, the updated `bidirectional-chat` skill installed, and the gateway restarted successfully.
- Live OpenClaw validation created a Claude task, listed Claude tasks, sent a follow-up message, and closed the task through plugin tools.
- Live OpenClaw validation created a Codex task with `ALL_PROXY=socks5h://127.0.0.1:1082` and `model=gpt-5.5/medium`, listed Codex tasks, sent a follow-up message, received Codex `done`, and closed the task through plugin tools.

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

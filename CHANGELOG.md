# Changelog

## 0.2.36 - 2026-07-10

### Added

- Notify OpenClaw when a terminal bridge Codex session is waiting for approval, including explicit approve and deny instructions.

### Fixed

- Resume terminal bridge monitoring after `AKK approve` succeeds so approved Codex work can still deliver its final callback.

## 0.2.35 - 2026-07-09

### Added

- Add a README cover illustration for Agent Knock Knock and include the optimized cover asset in the npm package.

## 0.2.34 - 2026-07-09

### Fixed

- Replace the README architecture image with an inline Mermaid diagram so the diagram renders without depending on raw GitHub image delivery.

## 0.2.33 - 2026-07-09

### Fixed

- Include the README architecture diagram asset in the published npm package so relative image links resolve on package readme surfaces.

## 0.2.32 - 2026-07-09

### Fixed

- Added an idle terminal-screen fallback for terminal bridge callbacks when Codex rollout history is unavailable or does not expose the current tmux task result.

## 0.2.31 - 2026-07-09

### Fixed

- Fixed terminal bridge callback delivery by avoiding unauthenticated gateway URL overrides and persisting the bridge send baseline so stale cwd-matched Codex rollout messages are not treated as the current task result.

## 0.2.30 - 2026-07-09

### Added

- Added terminal bridge monitoring for tmux-controlled Codex conversations so AKK can send only the user-facing task text, observe Codex rollout/terminal state, and deliver the OpenClaw callback itself.

## 0.2.29 - 2026-07-08

### Fixed

- Clarified AKK skill and `agent_knock_knock_send` tool routing so messages to listed AKK/Codex sessions, terminal-controlled rows, or tmux targets such as `my-work:0.1` use `send` instead of starting a new delegation.

## 0.2.28 - 2026-07-07

### Fixed

- Trimmed trailing newlines before sending terminal-controlled Codex messages through tmux and submitted with `C-m`, preventing payload newlines from being left in the Codex input box without starting the task.

## 0.2.27 - 2026-07-06

### Fixed

- Fixed Codex prompt delivery when using an explicit ACPX `--agent` adapter by invoking the top-level `prompt` subcommand before `-s <session>`.

## 0.2.26 - 2026-07-06

### Fixed

- Routed AKK Codex ACPX delegation through the supported `@agentclientprotocol/codex-acp` adapter with an explicit `--agent` command, avoiding OpenClaw ACPX installs that still bundle deprecated `@zed-industries/codex-acp`.
- Kept `AKK_CODEX_ACPX_AGENT_COMMAND` as an override for custom Codex ACP adapters while refusing explicit `@zed-industries/codex-acp` overrides.

## 0.2.25 - 2026-07-06

### Fixed

- Refused to start Codex through ACPX installations that still reference deprecated `@zed-industries/codex-acp`, preventing AKK from repeatedly launching stale or quarantined Codex adapter binaries.

## 0.2.24 - 2026-07-04

### Fixed

- Ignored injected Codex `<environment_context>` messages when choosing the initial request for `AKK describe`, falling back to the Codex thread title when no real user message is available.

## 0.2.23 - 2026-07-04

### Fixed

- Declared `agent_knock_knock_describe` in the OpenClaw plugin contract and metadata so OpenClaw exposes the new describe tool.
- Updated the installed AKK skill routing rules to use `agent_knock_knock_describe` for session-content summary requests instead of falling back to direct terminal inspection.

## 0.2.22 - 2026-07-04

### Added

- Added `AKK describe` / `AKK summary` to summarize what an AKK-managed, native Codex, or terminal-controlled Codex session is about.
- Added the `agent_knock_knock_describe` OpenClaw tool and `/akk describe <conversation-id>` command.
- Reused Codex rollout history for exact session matches, added cwd-based fallback matching, and returned screen-only summaries with explicit low-confidence limitations when no history can be found.

## 0.2.21 - 2026-07-03

### Added

- Added structured tmux Codex activity detection for terminal-controlled sessions, exposing `activity_state` and `activity_reason` in `AKK status` and `AKK list`.
- Classified terminal-controlled Codex panes as `awaiting_approval`, `working`, `idle`, or `unknown` using conservative current-screen heuristics.
- Added regression coverage for approval, stale approval scrollback, working, idle, unknown, and list activity-state output.

## 0.2.20 - 2026-07-02

### Fixed

- Ignored stale Codex approval prompts left in tmux scrollback after later terminal activity, preventing `AKK list`, `AKK status`, and `AKK approve` from treating already-approved prompts as pending.
- Added regression coverage to ensure stale approval scrollback does not mark terminal-controlled sessions as blocked or send an approval key.

## 0.2.19 - 2026-06-30

### Fixed

- Added a guarded cwd-based tmux pane fallback so wrapper-launched Codex sessions, such as sidecar-managed panes, are detected as `terminal_controlled` when their process cwd uniquely matches a tmux pane path.
- Preserved existing pid ancestry matching and avoided cwd fallback when multiple panes share the same cwd, preventing ambiguous terminal-control attachment.

## 0.2.18 - 2026-06-30

### Fixed

- Classified Codex remote compact stream disconnects as recoverable executor failures instead of leaving AKK tasks stuck as generic `stalled` conversations.
- Allowed `AKK recover` to replay saved AKK history and the pending OpenClaw message after a recognized monitor-time executor failure.

## 0.2.13 - 2026-06-25

### Fixed

- Allowed terminal-controlled `AKK status` and `AKK approve` to use `terminal_controlled` ids from `AKK list` directly without requiring an AKK delegated state file.
- Revalidated the current tmux target and pane pid before reading the terminal screen or sending the approval key.

## 0.2.11 - 2026-06-25

### Added

- Added terminal-controlled `AKK cancel` support by sending Control-C to the controlled tmux pane.
- Added structured terminal reachability, screen, and approval state to `AKK status` for terminal-controlled sessions.

### Removed

- Removed the public `agent discover` CLI path and `agent_knock_knock_agent_discover` OpenClaw tool; use `AKK list` for active/local session visibility.
- Removed the legacy `safe_resume` takeover strategy; native takeover now uses active process-based terminate, terminal-control, or fork paths.

## 0.2.10 - 2026-06-25

### Fixed

- Added parsing for underscore-delimited tmux pane output observed in OpenClaw Gateway terminal diagnostics, allowing those panes to be matched back to Codex processes.

## 0.2.9 - 2026-06-25

### Fixed

- Added a whitespace-delimited tmux pane parser fallback for environments where `tmux list-panes` output is not parsed by the tab-delimited path, and included a bounded `stdoutPreview` in terminal diagnostics.

## 0.2.8 - 2026-06-25

### Added

- Added `AKK list --terminal-debug` and the OpenClaw `terminalDebug` list parameter to expose tmux command, socket, pane, and spawn-attempt diagnostics when terminal-controlled sessions are not detected through the Gateway.
- Added `scripts/verify-terminal-control.mjs` to validate local Codex/tmux PID mapping against either the source build or an installed package before publishing.

## 0.2.7 - 2026-06-25

### Fixed

- Added tmux socket discovery across `/private/tmp/tmux-*` and `/tmp/tmux-*` directories so OpenClaw Gateway environments do not need to infer the interactive terminal user's tmux socket from their own process UID.

## 0.2.6 - 2026-06-25

### Fixed

- Added tmux executable path fallback for OpenClaw Gateway environments whose service `PATH` cannot resolve `tmux`, allowing `AKK list` and terminal-control actions to discover and operate tmux panes via common absolute install paths.

## 0.2.5 - 2026-06-25

### Added

- Added grouped `AKK list` output for `delegated`, `native`, and `terminal_controlled` sessions while preserving the legacy `tasks` field.
- Added terminal-controlled approval state to `AKK list`, allowing tmux-backed Codex sessions to show when an approval prompt is visible and approvable.

### Changed

- Updated OpenClaw routing guidance so active/native Codex session questions use `AKK list` instead of the separate native discover tool.

## 0.2.4 - 2026-06-24

### Fixed

- Added tmux socket fallback discovery for OpenClaw Gateway environments whose service `TMPDIR` differs from the user's interactive terminal, allowing active discovery to mark tmux-controlled Codex panes reliably.
- Preserved the discovered tmux socket path through terminal-control takeover, status, send, and approve operations so follow-up terminal actions use the same tmux server.

## 0.2.3 - 2026-06-24

### Fixed

- Added the tmux takeover tools to the OpenClaw plugin manifest contracts, allowing OpenClaw to expose `agent_knock_knock_agent_discover`, `agent_knock_knock_agent_takeover`, and `agent_knock_knock_approve` after installation.

## 0.2.2 - 2026-06-24

### Added

- Added tmux-backed terminal-control takeover for native Codex sessions, including tmux pane metadata in active discovery, confirmed `terminal_control` attachment, direct follow-up sends to the existing pane, and a conservative `approve` command for the currently visible Codex approval prompt.

## 0.2.1 - 2026-06-22

### Changed

- Deprecated the standalone restart recovery path from the OpenClaw-facing tool, slash command, skill, and docs. Conversations that need recovery now present `recover`, `close`, or starting a new independent delegation.
- Changed `send` to automatically fall back to AKK replay recovery when the previous ACPX session is unavailable. Explicit recovery decisions remain available only through `--recovery-policy explicit`.

## 0.2.0 - 2026-06-22

### Added

- Added experimental native Codex session discovery and takeover flows, including safe resume, OpenClaw-summarized fork, and confirmed terminate-then-resume adoption for active Codex CLI sessions.
- Added an explicit `allowCwdOnly` terminate-then-resume fallback for Codex TUI processes that do not expose a session id in argv; it still requires a user-confirmed pid and cwd re-scan before termination.
- Added tests for Codex native session takeover planning, confirmed termination safeguards, fork summary confirmation, and native `codex exec resume` follow-up delivery.

### Changed

- Updated Codex takeover sends to use native `codex exec resume` for adopted Codex sessions, avoiding ACPX session binding issues when resuming existing terminal Codex sessions.

## 0.1.2 - 2026-06-21

### Fixed

- Fixed stalled-task notifications from the background monitor when no explicit Gateway token is stored, allowing local OpenClaw CLI credentials to deliver the stalled callback and including a short executor-output trace in the notification.

## 0.1.1 - 2026-06-21

### Fixed

- Normalized Codex ACPX slash-style model shorthands such as `gpt-5.5/medium` to ACPX bracket model ids such as `gpt-5.5[medium]`, preventing Codex tasks from stalling before callback when a configured model uses the older shorthand.

## 0.1.0 - 2026-06-21

First public npm release for Agent Knock Knock, including OpenClaw plugin integration, local coding-agent delegation, task management, Cursor support, diagnostics, and packaged installation.

### Added

- Added ACPX executor metadata so delegations can target Claude Code, Codex, or Cursor.
- Added CLI task management commands: `list`, `status`, `send`, and `close`.
- Added OpenClaw plugin tools for task listing, task status, follow-up sends, and local task close.
- Added the `/akk` OpenClaw command for direct delegation, task listing, status, follow-up sends, and task close from command-capable chat surfaces.
- Added manifest contracts and tool metadata for the new OpenClaw plugin tools.
- Added cooperative AKK cancellation through `agent-knock-knock cancel`, `agent_knock_knock_cancel`, and `/akk cancel <conversation-id>` for Codex, Claude, and Cursor ACPX sessions.
- Added Codex ACPX proxy and model configuration support for environments that require `ALL_PROXY` or a ChatGPT-compatible model id.
- Added lazy idle-timeout cleanup for idle AKK sessions, configurable with `idleTimeoutMinutes` and defaulting to 10080 minutes.
- Added runtime diagnostics logs under `~/.agent-knock-knock/logs`, with local timestamps, daily NDJSON files, secret redaction, log-level filtering, and retention cleanup.
- Added safe executor trace support through `agent-knock-knock status --trace` and the OpenClaw status tool's `trace` parameter, summarizing tool calls, permission requests, client events, monitor events, and redacted thinking markers.
- Added a coding-agent executor registry that centralizes Codex, Claude Code, and Cursor ACPX metadata, aliases, protocol actors, session naming, and proxy/model configuration.
- Added an explicit recovery-decision foundation with `needs_recovery`, `agent-knock-knock recover`, `agent-knock-knock restart`, `agent_knock_knock_recover`, `agent_knock_knock_restart`, `/akk recover`, and `/akk restart`.
- Added Cursor as a supported ACPX coding-agent executor with `AKK Cursor`, `/akk cursor`, `agent="cursor"`, Cursor session/model/proxy config keys, and conservative explicit recovery decisions.
- Added npm package metadata, public package file allowlist, and a tag-driven GitHub Actions release workflow for publishing `@scotthuang/agent-knock-knock`.
- Added `agent-knock-knock install-openclaw` for installing the packaged OpenClaw plugin and skill template locally.
- Added `agent-knock-knock doctor` for checking required local commands, available coding agents, and packaged runtime files.
- Added tests for Codex-backed delegation and task management flows.
- Added tests for the executor registry used by Codex, Claude Code, and Cursor.
- Added tests for explicit recovery decisions, AKK history replay recovery, and restart without history replay.
- Added tests for Cursor delegate, send, cancel, route metadata, and unavailable-session recovery decision behavior.
- Added tests for runtime diagnostics logging, redaction, retention cleanup, and CLI log emission.

### Changed

- Changed actionable callback delivery from Gateway `sessions.send` to `chat.send` with `deliver: true`, so callbacks injected into channel-scoped OpenClaw sessions can use the original outbound channel route.
- Changed coding-agent `done` callbacks to move AKK conversations to `idle` instead of terminal `done`, allowing follow-up sends to continue the same session until manual close or idle timeout.
- Updated `done` callback messages to include concise AKK convenience commands such as `AKK list`, `AKK send <conversation-id>: <message>`, `AKK status`, and `AKK close`.
- Updated OpenClaw plugin routing descriptions so `AKK` and `akk` both indicate Agent Knock Knock, and unspecified AKK delegations default to Codex.
- Updated the OpenClaw skill template so follow-up language such as "continue", "再让它", or "给刚才那个" defaults to reusing the most recent matching open AKK session through `agent_knock_knock_send`.
- Updated the OpenClaw skill template with AKK cancel routing for stopping current in-flight work without closing the reusable AKK session.
- Updated the OpenClaw skill template with AKK/akk routing, configurable default-agent delegation, explicit agent routing, and task management tool usage.
- Updated follow-up sends from OpenClaw to launch the coding agent in the background so OpenClaw can continue to subsequent tool calls.
- Migrated the implementation source to TypeScript and moved runtime entrypoints to compiled `dist/src` output.
- Migrated the Node test suite to TypeScript and updated `npm test` to build before running compiled tests from `dist/test`.
- Updated `npm run build` to clean stale compiled output before TypeScript compilation, and added `prepack` so npm publish/pack builds fresh runtime files.
- Changed `delegate` to generate a unique ACPX session for each new coding-agent task unless a session is explicitly configured, preventing concurrent AKK tasks from sharing the same default Codex, Claude, or Cursor session.
- Added a background executor monitor that marks agent-waiting tasks `stalled` when the launched process exits without a callback or when the configurable `agentTimeoutMinutes` callback timeout is reached, then attempts to notify the original OpenClaw session.
- Renamed the OpenClaw skill template from `bidirectional-chat` to `agent-knock-knock` so the installed skill matches the project and plugin name.
- Updated documentation to describe local coding agents, task management, cooperative cancellation, and the home-directory conversation store.
- Updated documentation with the local update flow required to rebuild and reload the linked OpenClaw plugin after project changes.
- Updated the OpenClaw skill template and README with conservative recovery guidance for coding agents whose native session resume is unreliable.
- Updated the OpenClaw skill template, README, plugin manifest, and protocol docs for Cursor routing and task management.
- Updated README, plugin metadata, and skill guidance to document the configurable `defaultAgent` flow for unspecified AKK delegations.
- Documented ACPX approval behavior: Claude Code permission requests work with `--approve-all`, while some Codex sensitive operations can fail directly under AKK's non-interactive/background path instead of surfacing an approvable ACPX permission request.

### Fixed

- Fixed OpenClaw plugin delegations generating `--record-only` callback commands even when Gateway callback delivery was configured, which caused completed Codex tasks to be logged locally without returning results to OpenClaw.
- Fixed chat-routed `/akk cursor ...`, `/akk claude ...`, and `/akk codex ...` requests being treated as unspecified delegations when OpenClaw called the delegate tool without an explicit `agent` parameter.

### Verified

- `npm test` passes 53 tests.
- `npm --cache /private/tmp/akk-npm-cache pack --dry-run` verifies the scoped npm package contents.
- Local OpenClaw installation validated with the npm-installed Agent Knock Knock plugin loaded, the updated `agent-knock-knock` skill installed, and the gateway restarted successfully.
- Live OpenClaw validation created a Claude task, listed Claude tasks, sent a follow-up message, and closed the task through plugin tools.
- Live OpenClaw validation created a Codex task with a configured `ALL_PROXY` value and `model=gpt-5.5/medium`, listed Codex tasks, sent a follow-up message, received Codex `done`, and closed the task through plugin tools.
- Live ACPX validation created smoke sessions for Codex and Claude Code, called AKK cancel for each, observed `executor_cancel_requested` events with status 0, and closed the smoke ACPX sessions.
- Published `@scotthuang/agent-knock-knock@0.1.0` to npm.
- Created GitHub Release `v0.1.0`.

### Initial MVP Baseline

Initial MVP for managed bidirectional agent delegation.

#### Added

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

#### Verified

- `npm test` passes.
- Conversation creation writes state and NDJSON logs.
- Message recording updates conversation state.
- Two-Claude architecture scenario completes with correct round accounting:
  - `task`, `question`, `answer`, `question`, `answer` count as response rounds.
  - `done` does not increment response rounds.
- Two-Claude weather scenario records blocked/failure flows when live weather lookup is unavailable.

#### Known Issues

- `blocked` handling was corrected after the first weather test; older logs may show `blocked` as `requires_response=false`.
- The two-Claude simulation currently stores full raw `acpx` output in logs, including client/tool status lines.
- The script does not yet parse the model's returned JSON into canonical message body fields.
- Real OpenClaw Gateway integration is not implemented yet; current implementation simulates OpenClaw with Manager Claude.

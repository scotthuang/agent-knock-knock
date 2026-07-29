# Changelog

## 0.5.1 - 2026-07-29

### Changed

- Put one complete ClawHub-first path from installation through workspace setup, Gateway restart, tmux startup, diagnostics, and the first task at the top of the README.
- Separate direct `/akk` usage from optional natural-language tool access and keep the npm installer as an alternative path.

### Fixed

- Fail closed with actionable setup guidance when the plugin workspace is missing or non-absolute instead of falling back to the Gateway working directory.
- Keep `/akk doctor` available to diagnose invalid workspace configuration.

## 0.5.0 - 2026-07-29

### Changed

- Make already-running, verified-idle Codex and Claude Code tmux panes the only delegation targets.
- Resolve bare `/akk <task>` only when exactly one eligible idle pane exists in the configured workspace, and use `/akk <selector>: <message>` for an explicit target.
- Enforce the configured workspace as a hard boundary even for explicit terminal IDs and recovery operations.
- Keep the main command surface focused on task routing, listing, status, and cancellation; keep diagnostics, approvals, and recovery operations in their relevant workflows.

### Removed

- Remove configuration-based default-agent routing and the `--default-agent` installer option.
- Remove obsolete session inspection and attachment surfaces from the user-facing workflow.

## 0.4.0 - 2026-07-29

### Changed

- Focus Agent Knock Knock on one transparent execution path: shared tmux terminals for Codex and Claude Code.
- Reuse exactly one idle agent pane in the configured workspace and fail closed when no unique safe target exists.
- Prevent a new terminal generation from replacing an active task, persist exact dispatch receipts across stores, and fence uncertain submissions until their owner is explicitly closed.
- Simplify installation, diagnostics, plugin tools, the bundled skill, and documentation around the tmux handoff workflow.

### Removed

- Remove the alternative managed execution stack, blanket background approval, non-tmux agent integration, model/proxy overrides, and callback bootstrap contract.
- Remove obsolete quickstarts, smoke tests, simulations, modules, and maintenance assets for unsupported execution paths.

## Earlier releases

The pre-0.4 history remains available in [GitHub Releases](https://github.com/scotthuang/agent-knock-knock/releases).

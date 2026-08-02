# Changelog

## 0.8.1 - 2026-08-03

### Fixed

- Keep automatic and manual callback retries config-routed when no durable Gateway token exists, instead of restoring a tokenless explicit URL that OpenClaw rejects.
- Preserve persisted, explicitly authenticated Gateway URL and token pairs across retries without copying credentials into callback delivery state.

## 0.8.0 - 2026-08-01

### Changed

- Make `AKK list` terminal-first: every discovered tmux pane is a single primary `terminals[]` resource with its authoritative current turn or latest retained turn nested below it.
- Replace ambiguous managed-turn `send` hints with `follow_up`, keep historical turns explicitly addressable, and limit default selectors to physical terminal candidates.
- Determine current terminal ownership from the dispatch ledger and suppress side effects when ownership is unresolved, while keeping the pane visible.

### Removed

- Remove the public `delegated[]`, `terminal_controlled[]`, `tasks[]`, legacy `commands`, and `source: "akk_delegate"` list compatibility model.

## 0.7.0 - 2026-08-01

### Changed

- Move managed task state to the permanent `~/.agent-knock-knock/store` root, with a compatibility manifest and conversation data under `conversations/`.
- Let OpenClaw-triggered `list` reconcile all managed tasks and `status` reconcile only its selected task. Standalone shell `list` and `status` stay read-only by default, expose reconciliation only through explicit `--reconcile`, and never change state while resolving a selector.
- Leave the former `~/.agent-knock-knock/conversations` store untouched and ignored. This release does not migrate old managed task records; existing tmux panes remain discoverable for new work.

### Security

- Refuse incompatible Store writers before changing managed state or performing terminal and Gateway side effects.
- Always use the plugin package's bundled relay and remove the configurable external `binPath` override.

## 0.6.2 - 2026-07-31

### Changed

- Publish `AKK list` action contract v2 with machine-readable field semantics that distinguish managed task lifecycle, terminal process liveness, parsed screen activity, deprecated compatibility flags, and the authoritative `available_actions` snapshot.

### Fixed

- Recognize both current `»` and legacy `›` Codex composer markers across idle detection, approval parsing, stale-prompt rejection, completion boundaries, and terminal artifact cleanup while preserving fail-closed working and approval precedence.

## 0.6.1 - 2026-07-30

### Added

- Return per-session `available_actions` and a versioned action contract from `AKK list`, including exact tool names, authoritative target arguments, fresh-status approval prerequisites, and recovery message IDs when currently available.

### Fixed

- Exclude unsupported and retired ACPX executor records from session discovery so historical Cursor or pre-tmux state cannot break valid Codex and Claude Code routing, while active legacy ownership still fences its pane against double dispatch.
- Keep idle cleanup logging safe when it closes an unsupported legacy executor record.

## 0.6.0 - 2026-07-30

### Changed

- Discover and control verified Codex and Claude Code tmux panes across workspaces without project-specific plugin configuration.
- Keep bare delegation fail-closed when multiple idle panes exist, while allowing exact selectors to route safely across projects.
- Revalidate the coding-agent PID, tmux pane identity, and matching process/pane working directory before terminal operations.
- Simplify ClawHub and npm installation, diagnostics, and first-run guidance by removing the top-level workspace setup step.

### Security

- Keep automatic approval disabled by default and scoped only by each trusted rule's exact commands, agents, and one or more `autoApprove.rules[].workspaces` roots.

### Removed

- Remove the top-level plugin `workspace` setting and the corresponding `install-openclaw` and `doctor` workspace options.

## 0.5.2 - 2026-07-30

### Fixed

- Keep macOS tmux workspace revalidation reliable when `lsof` returns usable cwd rows with a partial-failure status.
- Limit cwd lookups to the expected coding-agent PID while retaining ancestry checks and failing closed when target cwd evidence is absent.

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

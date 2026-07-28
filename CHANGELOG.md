# Changelog

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

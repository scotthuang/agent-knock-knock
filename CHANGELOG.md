# Changelog

## 0.10.0 - 2026-08-06

### Added

- Add capability-scoped native-thread lifecycle controls for starting or clearing context, listing verified same-workspace resume candidates, and resuming one exact Codex or Claude Code native thread in the existing tmux pane.
- Add the optional OpenClaw tools `agent_knock_knock_new_thread`, `agent_knock_knock_list_resumable_threads`, and `agent_knock_knock_resume_thread`, plus `/akk new-thread`, `/akk clear-thread`, `/akk threads`, and `/akk resume-thread` human-facing commands.
- Publish the v5 list/action contract with exact terminal lifecycle targets, complete native-thread identities, fresh compare-and-swap binding tokens, per-candidate evidence fingerprints, and capability-gated availability.

### Changed

- Keep ordinary sends scoped to the current native context: each accepted send creates a new Turn, while a successful native lifecycle transition creates or activates an AKK Session and creates no Turn.
- Treat a sole historical Session whose recorded coding-agent PID has conclusively exited as resumable on the next lifecycle listing; the resume mutation compare-and-swap detaches that stale binding before terminal input, without background polling.
- Let human-facing lifecycle slash commands fetch a fresh binding token internally immediately before mutation; plugin tools retain the explicit token so OpenClaw follows an auditable list-then-mutate flow.
- Record terminal binding generations and native-thread transition lineage so sends after new/clear or resume target only the newly verified context.
- Upgrade the Store writer protocol to v3. The first mutation of a v1 or v2 predecessor durably materializes authoritative Session records before publishing the new manifest, quarantines ambiguous bindings, and leaves existing Turn state and event logs unchanged.

### Security

- Serialize native-thread transitions against sends, approvals, monitors, callbacks, and recovery; require an exact idle terminal with no unresolved Turn and fail closed on unsupported, ambiguous, stale, active-elsewhere, or unverifiable native identity evidence.
- Fence old monitors, receipts, approvals, callbacks, and recovery mutations to their original terminal incarnation, native thread, AKK Session, Turn, and binding generation.
- Reject every first-line native slash command at the ordinary send/respond boundary before creating Session, Turn, ledger, or terminal side effects, including lifecycle-changing `/clear`, `/new`, `/resume`, Codex `/fork`/side threads, and Claude `/branch`.

## 0.9.0 - 2026-08-05

### Added

- Add a durable AKK `session_id` for the continuing native coding-agent context and a unique `turn_id` for every accepted terminal dispatch.
- Add an explicit `respond(turn_id, answer)` path for questions and blocked requests that must continue the same in-flight turn.

### Changed

- Make ordinary sends to an existing AKK Session target its `session_id` and create a new Turn, while managed status, approval, cancellation, retry, renewal, and close operations target an exact `turn_id`.
- Keep first attach and raw-terminal control compatibility narrow and list-driven: an unmanaged row may prefill its own `selector` for initial send or `conversation_id` for an advertised raw status, approval, cancellation, or orphan-close action; callers must never construct, guess, or reuse either value.
- Publish the v4 list/action contract with terminal → session → turn history, and include both identities in messages, callbacks, delivery ledgers, and recovery output.
- Treat existing `conversation_id` values as legacy Store aliases; new records keep `conversation_id` equal to `turn_id`, while legacy records receive in-memory identity fallbacks.
- Upgrade the Store writer protocol to v2 and atomically migrate exact v1 manifests on the first mutation while preserving legacy Turn records.

### Security

- Fail closed when native Codex or Claude Code session evidence is unavailable or changes, when persisted identity fields conflict, or when callback identity sources disagree.
- Fence terminal receipts and late callbacks to the exact Store, Session, Turn, message, and native process incarnation so stale work cannot cross execution boundaries.

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

# Roadmap

This roadmap describes the direction for Agent Knock Knock as a local coding-agent session-management layer and OpenClaw control plane.

OpenClaw remains the primary control surface, especially for WeChat and other text-first channels, but the project goal is broader than starting new delegated tasks. Coding agents such as Codex, Claude Code, and Cursor all have their own CLIs, local session stores, resume behavior, cancellation behavior, and permission models. Agent Knock Knock should provide one stable layer for discovering, delegating, resuming, taking over, forking, and managing those local agent sessions while absorbing agent-specific compatibility changes behind adapters.

The priority order is intentional: reliability comes first. New orchestration features are only useful if delegation, callbacks, cancellation, and recovery are predictable enough for daily use.

## Priority 1: Reliability And Operations

- Done for terminal control: make bridge timeouts activity-aware, retain a hard lifetime, renew stalled monitors without terminal input, enforce a single monitor owner, and reconcile safe tasks after Gateway restarts.
- Partial: delegated ACPX monitors detect dead executors and callback timeouts; improve handling of ambiguous live states.
- Partial: classify reconnect, permission, sandbox, timeout, and process failures; make every category consistently actionable.
- Make `cancelling` converge to a terminal or reusable state after successful cancel, agent callback, or timeout.
- Partial: expose sanitized task traces and terminal diagnostics; add stronger diagnosis for Codex reconnect/internal-error cases.
- Done for terminal bridge: expose callback delivery state, bounded retries, and idempotent manual retry without requiring OpenClaw to inspect raw process output.
- Partial: runtime logs avoid full CLI argv and redact common secrets, but retain bounded payload previews and local paths for diagnostics.
- Partial: `doctor` validates required commands, available agents, and packaged files. Add installed-plugin, skill, Gateway, and live-session checks.
- Partial: fake-agent regression tests cover delegation, follow-up, cancel, close, and callback routes, and Claude tmux has been verified manually. Add repeatable live Codex and Claude smoke tests.

## Priority 2: Simpler Session Control

- Let users send follow-ups without typing a full conversation id when there is only one obvious open session.
- Support agent-targeted shortcuts such as `AKK send codex: ...` or `AKK send claude: ...`.
- Add short task aliases or titles so sessions are easier to identify from WeChat and other text-first channels.
- Partial: `AKK list` includes update time, status, agent, and session; add last activity and callback summaries.
- Make idle session reuse rules more explicit and easier to override when the user wants a new independent task.

## Priority 3: Agent Session Discovery And Adoption

- Done for Codex: discover active local Codex CLIs by scanning same-user processes, cwd, argv, and child process trees.
- Done for Codex: discover inactive or historical Codex sessions from `threads` metadata and rollout JSONL files.
- Done for Codex: separate process discovery from resumable-session discovery. Active processes identify likely workspaces; stable session ids are the real anchor for resume, takeover, and fork.
- Done for Codex: expose active, historical, and terminal-controlled sessions through `AKK list` and takeover planning, including risk-relevant process and session metadata.
- Done for Codex: register an existing native Codex session as an AKK-managed conversation without immediately sending a message.
- Done for Codex: support explicit takeover for active CLI sessions by asking for confirmation, terminating the selected same-user process tree, verifying exit, and then resuming the selected session.
- Done for Codex: support a higher-risk `allowCwdOnly` fallback for Codex TUI processes that do not expose a session id in argv; this requires a user-confirmed pid and cwd re-scan before termination.
- Done for Codex: support OpenClaw-mediated fork as a safer alternative. AKK extracts bounded source context from the original session, OpenClaw summarizes it for user review, the user confirms, and only then AKK creates a new managed session in the same workspace using the approved summary.
- Done for Codex: store adoption metadata in AKK state, including source agent, source session id, workspace, native model, strategy, and takeover match kind.
- Done for Claude Code terminal control: discover exact live CLI processes in tmux, send only at a verified idle prompt, and bind monitoring to the exact session, process, pane, conversation, message, and lease.
- Remaining: validate the full Codex native takeover flow through installed OpenClaw plugin tools, not only the local CLI.
- Remaining: define native-store discovery and adoption for Cursor and Claude Code after their local resume behavior is verified. This is separate from the existing Claude tmux bridge.

## Priority 4: Agent Compatibility Layer

- Done for Codex: isolate process, store, rollout, and terminal discovery behind compatibility providers.
- Done for Codex: list recent sessions, read metadata, extract bounded rollout context, detect active processes, and degrade when local data is incomplete.
- Done for terminal control: use registry-backed Codex and Claude Code adapters with agent-aware IDs and fail-closed capabilities.
- Partial: treat rollout JSONL as best-effort input, skip unknown events, and avoid encrypted reasoning content; add sensitive-value redaction before exposing parsed context.
- Partial: inline unit tests cover missing data, store variation, bounded long context, and partial degradation; add explicit unknown-shape and encrypted-reasoning cases.
- Remaining: detect a wider range of future Codex local-store layouts without hardcoding schema assumptions.
- Define equivalent native-store discovery and adoption adapters for Cursor and Claude Code only after their resume and local-store behavior is verified.
- Document that local session discovery depends on best-effort compatibility with agent-local storage, not stable public APIs from the coding-agent vendors.

## Priority 5: OpenClaw Tool Relay

- Allow delegated Codex or Claude agents to request OpenClaw-owned capabilities instead of being limited to their own ACPX tools.
- Introduce a structured request/response flow for agent-to-OpenClaw tool calls, for example `tool_request` and `tool_result`.
- Let OpenClaw decide whether a requested capability should run automatically, be denied, or ask the user for confirmation.
- Start with a small allowlist of safe OpenClaw tools before exposing broad tool schemas.
- Preserve the current rule that coding agents communicate through AKK callbacks instead of directly polling OpenClaw internals.

## Priority 6: Capability Manifest

- Include a compact OpenClaw capability summary in the agent bootstrap prompt.
- Describe available capability categories without sending every full tool schema by default.
- Let agents request more detailed schema only when they need a specific capability.
- Keep capability manifests channel-aware so agents do not assume a tool or delivery path exists in every OpenClaw session.

## Priority 7: Permission And Approval Broker

- Done: document the observed difference between Claude Code and Codex approval behavior under ACPX.
- Done for terminal-controlled Codex: support audited, deterministic auto-approval rules for exact command vectors inside configured workspaces.
- Done for Claude Code tmux: detect a narrowly verified permission screen without hooks, require an explicit human `AKK approve`, and fail closed when the request or runtime identity is stale, unknown, or ambiguous.
- Continue to prefer Claude Code for tasks that need ACPX-approved filesystem access outside the workspace until Codex exposes equivalent approvable permission requests.
- Partial for terminal control: configuration policies can approve exact commands; extend them to explicit deny and user-escalation rules.
- Done for terminal control: approval decisions are one-shot, fingerprinted, revalidated, persisted, and auditable rather than blind global grants.
- Remaining: generalize approval state and events to ACPX delegation and future OpenClaw tool-relay permissions.

## Priority 8: Artifact Delivery

- Add a structured artifact event for files, images, reports, and other outputs generated by delegated agents.
- Track artifact path, MIME type, summary, and suggested delivery action.
- Let OpenClaw decide whether to send an artifact to the current channel, summarize it, or leave it as a local file reference.
- Support channel-specific delivery behavior, especially for WeChat and other mobile-first surfaces.

## Priority 9: AKK Console

- Build a local web UI, app, or Workboard integration for inspecting AKK-managed agent sessions.
- Show all AKK-managed Codex, Claude Code, and Cursor tasks with agent, ACPX session, source session id when adopted, status, created time, updated time, last callback, and round usage.
- Show session detail from `state.json` and `events.ndjson`, including request summary, event timeline, callback transcript, errors, artifacts, and diagnostic log references.
- Show discovered but not-yet-adopted active and historical coding-agent sessions when the relevant compatibility adapter supports discovery.
- Add filters for running, idle, cancelling, blocked, failed, and closed sessions.
- Add search by conversation id, user request, agent, session name, and workspace.
- Support safe management actions such as cancel, close, archive/delete, copy conversation id, and open workspace.
- Keep the first version mostly read-only. Follow-up messaging should continue to go through OpenClaw until synchronization semantics are explicit.
- Avoid creating a second unsynchronized chat surface; if direct UI follow-up is added later, model it as an OpenClaw-originated AKK message so state remains coherent.
- Keep the console as an operational aid, not the source of truth; durable state should remain in AKK conversation files.

## Long-Term Direction

- Support more local coding agents through the same executor abstraction.
- Keep a stable AKK session-management interface while Codex, Cursor, Claude Code, and other local agents evolve their CLI and storage behavior.
- Add orchestration policies for splitting work across multiple agents.
- Build higher-level workflows where OpenClaw manages planning, delegation, tool relay, artifact delivery, and final acceptance.
- Keep the project local-first, inspectable, and conservative about credentials, permissions, and workspace boundaries.

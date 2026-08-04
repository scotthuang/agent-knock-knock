# Roadmap

Agent Knock Knock is a local tmux terminal handoff bridge for OpenClaw, Codex, Claude Code, and humans.

OpenClaw remains the remote control and orchestration surface. AKK keeps each coding-agent context in a visible terminal and records each dispatch as a Turn, so a human can inspect it, take over directly, and hand it back without creating a second hidden session.

The priority order is intentional: reliability and transparency come before adding more agents or orchestration features.

## Priority 1: Terminal Reliability

- Keep terminal monitors bound to the exact tmux pane, process, workspace, AKK Session, Turn, message, and lease.
- Reconcile safe monitors after Gateway restarts without duplicating callbacks.
- Make completion, approval, cancellation, timeout, and callback failures consistently actionable.
- Keep uncertain or unsupported terminal states visible and fail closed.
- Expand repeatable live Codex and Claude Code smoke coverage.

## Priority 2: Handoff Experience

- Make it obvious whether OpenClaw, the coding agent, or the human currently owns the next action.
- Improve phone-friendly Session/Turn summaries, short references, and later-request selection.
- Keep direct human takeover and hand-back seamless in the same tmux pane.
- Make interrupt, status, renew, close, and callback retry behavior predictable.

## Priority 3: Approval Safety

- Keep automatic approval disabled by default.
- Match only exact command vectors for configured agents and canonical workspaces.
- Preserve one-shot fingerprints, short-lived evidence, process revalidation, and private audit records.
- Add explicit deny and escalation policies without weakening the manual terminal path.
- Continue failing closed for stale, changed, replayed, ambiguous, or unsupported prompts.

## Priority 4: Agent Compatibility

- Maintain registry-backed Codex and Claude Code terminal adapters.
- Treat agent-local transcripts and session stores as best-effort compatibility inputs, not stable vendor APIs.
- Detect schema and process changes conservatively and expose useful diagnostics.
- Add another coding agent only after it has a verified tmux adapter with safe input, interrupt, approval, and completion behavior.

## Priority 5: Session Visibility

- Improve `AKK list`, status, and description with last activity, callback state, terminal target, and bounded context.
- Keep unmanaged local sessions clearly separated from controllable tmux entries.
- Make every control action resolve an exact terminal identity and fail on ambiguity.

## Priority 6: OpenClaw Collaboration

- Let OpenClaw coordinate planning, implementation, and review across multiple visible agent terminals.
- Explore structured requests for OpenClaw-owned capabilities with explicit authorization boundaries.
- Add artifact metadata for files, images, reports, and other outputs while keeping local paths and secrets private.

## Priority 7: Local Operations View

- Build a local view for managed terminal turns, callback state, approvals, errors, and diagnostics.
- Keep the first version mostly read-only and preserve the filesystem state as the source of truth.
- Avoid creating a second unsynchronized chat surface.

## Long-Term Direction

- Keep AKK focused on visible, inspectable terminal collaboration.
- Absorb Codex, Claude Code, tmux, and OpenClaw compatibility changes behind conservative adapters.
- Build higher-level workflows where OpenClaw coordinates specialist agents while a human can always return to the terminal and take control.

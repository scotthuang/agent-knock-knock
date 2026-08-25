# Changelog

## Unreleased

### Added

- Add a Host-owned foreground MCP/stdio Bridge that exposes the existing 16 semantic AKK tools without introducing a second state or tool model.
- Add strict Host Profile v1 configuration with trusted environment session binding, a shell-free `command_json_v1` callback driver, compatibility/doctor commands, a published JSON Schema, and a starter user Profile.

### Changed

- Reuse the shared Host lifecycle and existing durable callback route, outbox, retry, and settlement core for configuration-only Hosts while preserving the native OpenClaw adapter unchanged.

### Security

- Keep Profile selection, controller identity, executable, arguments, credentials, and acknowledgement rules outside model-facing tool inputs; exact route fingerprints and delivery/message acknowledgements fail closed on drift.

## 0.12.15 - 2026-08-25

### Added

- Add the `terminal_user_explicit` physical Send authority domain, global message intent, and immutable omitted-target binding so an explicit user Send remains actionable independently of AKK management state.

### Fixed

- Prevent stale, stalled, deferred, corrupt, or missing Store, Session, Turn, transfer, activity, and dispatch-ledger state from vetoing an explicit user Send. When a zero-wait managed attempt proves that no input was submitted, fall back once to exact physical delivery and leave subsequent observation to Terminal Watch.
- Detach an exact same-incarnation bound Session left behind by failed managed preparation after physical fallback when no live blocking Turn remains, so a later Terminal Watch can attach normally.
- Retire an exact same-incarnation ordinary dispatch ledger whose owner Turn is gone after physical fallback, so a refreshed List can advertise Watch again; unresolved native lifecycle ledgers remain preserved.
- Reject ordinary native slash-command text before selector discovery, avoiding terminal or host-process scans for an invalid Send or Respond.
- Make OpenClaw doctor skill verification compatible with multi-agent installations that require an explicit `main` owner.
- Scope durable omitted-target delegate bindings to the active runtime directory, preventing in-process hosts with scoped `AKK_RUNTIME_DIR` values from sharing message-ID state.
- Bind explicit physical Send authority to the exact operating-system process incarnation and reject stale supplied authority before managed preparation or terminal input.

### Changed

- Advance the action contract to 19 and expose Send readiness from physical terminal evidence while retaining the existing Store format and writer protocol.

### Security

- Continue to require exact live terminal and process identity, approval eligibility, an empty composer, and unambiguous input evidence before physical Send. Possible prior input, true concurrency, or same-message ambiguity remains fail-closed and never triggers duplicate delivery.
- Keep fallback delivery free of synthetic Turns or callbacks, and treat post-delivery bookkeeping or cleanup failures as warnings without automatically replaying user input.
- Preserve a Session still named by an unresolved native lifecycle ledger instead of fabricating a transition outcome; the physical Send remains delivered and cleanup reports the retained recovery boundary.

## 0.12.14 - 2026-08-24

### Added

- Add an exact Codex `0.149.1` native lifecycle and `/status` inspection profile, retaining fail-closed handling for adjacent and future unverified versions.
- Add a versioned, host-neutral callback route and transport boundary with durable routing and idempotency authority while retaining OpenClaw as the concrete host adapter.

### Fixed

- Distinguish the exact Codex root user row from same-turn synthetic user-role context, preserving Terminal Watch until a later native task actually supersedes it.
- Safely recover eligible uncertain Send submissions through exact one-shot retry and reconciliation without replaying accepted input or replacing the original request.
- Make explicit Close honor the user's management-release decision first, with best-effort linked cleanup, warning-only cleanup conflicts, no terminal or coding-agent interruption, and immediate eligibility for a fresh Watch.

### Security

- Freeze callback routing and idempotency authority durably, fail closed on route drift or ambiguous recovery, and keep model-facing callback and retry contracts free of opaque authority material.
- Require exact adjacent native-event evidence and a privacy-safe content hash when identifying Codex root user rows; missing, duplicate, orphaned, or mismatched evidence fails closed.

## 0.12.13 - 2026-08-22

### Added

- Add durable Terminal Watch for exact human-started Codex and Claude Code tasks, with restart-safe OpenClaw callbacks for approval, completion, failure, timeout, invalidation, and cancellation.
- Add `agent_knock_knock_watch` / `agent_knock_knock_unwatch`, `/akk watch` / `/akk unwatch`, and watch-aware list/status output without creating an AKK Session or Turn or sending terminal input.

### Fixed

- Derive Watch and Send authority from exact terminal IDs inside the trusted plugin/CLI boundary, so OpenClaw models never need to copy opaque tokens or fingerprints.
- Keep Watch activity authoritative when Codex's transient screen markers look idle, support large historical rollouts with incremental checkpoints, and isolate corrupt historical Watch records without starving healthy watches or callbacks.
- Restore follow-current Send across tmux route renumbering, stale legacy dispatch ledgers, long-lived Sessions with released earlier binding epochs, and interrupted v1-to-v2 ledger migration without replaying terminal input.

### Changed

- Advance the action contract to 18 and expand the OpenClaw plugin contract to 16 tools. Model-facing actions now carry semantic IDs only; opaque freshness and confirmation authority remains private to the plugin and CLI. Store writer protocol remains 5; Terminal Watch uses its own schema-v1 aggregate.

### Security

- Pin each Watch to exact terminal, process, native-task, runtime-version, rollout/transcript file, and privacy-safe request-hash evidence; drift fails closed and approval observations never authorize automatic input.
- Revalidate private Send, lifecycle, handoff, reconciliation, and approval authority under canonical terminal and Store locks; stale, split, replayed, cross-session, or callback-mismatched evidence sends zero terminal input.

## 0.12.12 - 2026-08-21

### Added

- Add exact native lifecycle and status compatibility for Codex `0.148.0` and Claude Code `2.1.237`, while retaining the previously verified profiles.
- Report exact native-profile support in CLI and OpenClaw doctor output without blocking ordinary terminal work for an otherwise available but unprofiled coding-agent executable.

### Changed

- Decompose the orchestration runtime into typed, ownership-checked domain facades and services while preserving action contract 16, Store writer protocol 5, public CLI/OpenClaw contracts, lock ordering, and durable-write ordering.
- Strengthen architecture enforcement with bounded production functions, canonical status authorities, targeted affected-test selection, and reproducible refactor evidence.
- Clarify the TUI-first handoff model and make fast tests the normal development/local-install gate while reserving the full release suite for actual npm and ClawHub publication.

### Security

- Keep adjacent unknown Codex and Claude Code versions fail-closed for native inspection and lifecycle operations, and enforce one-way Claude transcript resume compatibility across verified profiles.
- Preserve exact terminal identity, binding, approval, acceptance, callback, retry, and uncertainty fences across the internal architecture refactor.

## 0.12.11 - 2026-08-14

### Fixed

- Allow managed close to retire a Turn when its exact bound Codex or Claude Code process is conclusively absent, without falling into the managed/raw close deadlock.
- Stop terminal-monitor relaunch loops for verified-dead accepted Turns, while preserving completion-first settlement when the exact rollout or transcript already contains a durable result.
- Recover verified-dead stall and close transitions idempotently across event/state/ledger crash windows without replaying terminal input.

### Security

- Require a complete process inventory, exact Session and Turn binding generation, canonical terminal endpoint, process incarnation, dispatch ledger, and append-only native-acceptance receipts before dead-process cleanup; malformed, partial, conflicting, or unavailable evidence remains fail-closed.
- Distinguish durable completion as present, absent, or unverifiable for both Codex rollouts and Claude transcripts. Unverifiable evidence may stop orphan-monitor churn but cannot resolve the dispatch, renew the Turn, or trigger terminal input.

### Changed

- Keep action contract 16 and Store writer protocol 5 unchanged; no new public action or Store authority is introduced.

## 0.12.10 - 2026-08-13

### Fixed

- Scope Codex and Claude Code approval fingerprints to one adapter-isolated, exact unredacted prompt region, so unrelated terminal output can continue scrolling across review, authorization, and dispatch reservation without invalidating the same visible request.
- Normalize managed approval locking to terminal, Store writer, then Turn state order, eliminating the writer/state inversion that could amplify approval delays under concurrent monitor activity.
- Support the complete Codex 0.147 command, edit, permission, and MCP approval menus, including multi-choice decline/cancel rows and the permission deny shortcut.

### Changed

- Publish action contract 16. Whole-screen digests and excerpts are diagnostic only; v15 approval fingerprints and terminal-scoped approval tokens require a fresh `list` or `status` after upgrade.
- Store writer protocol remains 5.

### Security

- Revalidate the exact prompt-region digest with terminal, process, action, request, policy, and working-directory authority before approval input; missing, incomplete, duplicated, reordered, spoofed, or changed prompt evidence sends zero keys.
- Keep raw prompt text local to the adapter and out of status, Store records, tokens, logs, and failure diagnostics; only its SHA-256 digest participates in authorization.

## 0.12.8 - 2026-08-13

### Fixed

- Route every eligible quiescent rollout-backed Codex pane through terminal-follow-current candidate attribution, including single-root and multi-root inventories with resolved or unavailable foreground identity, then bind only the unique post-submit acceptor.
- Keep the Codex `/clear` resume hint advisory, so a valid fresh candidate action remains usable after the hint scrolls out of view while exact terminal, process, Store, inventory, and composer authority remains unchanged.
- Restore idempotent retry after a conclusively zero-input candidate-send abort without reusing the abandoned provisional Session or allowing binding drift.

### Changed

- Publish action contract 15. Rollout-backed Codex rows advertise `terminal_follow_current` instead of `session_exact`, and cached direct `session_id` sends reject before task input.
- Store writer protocol remains 5.

### Security

- Require a complete nonempty open-root inventory, exclusive candidate ownership, exact process and terminal incarnation, frozen source history and dispatch ledger, an idle empty composer, and no blocking Turn before candidate input; stale, incomplete, claimed, or ambiguous state remains fail-closed.

## 0.12.7 - 2026-08-12

### Fixed

- Follow a supported manual Codex `/clear` through a fresh terminal-scoped candidate send, binding only the rollout with one unique post-anchor acceptance without an internal `/status` probe.
- Restore future-send liveness after explicitly closing an uncertain predecessor when its resolved close ledger, append-only uncertain receipt, frozen Turn history, absent old rollout, and unclaimed current inventory remain exact.
- Recognize the supported Codex resume hint when its UUID wraps across lines in a narrow pane, while keeping the hint as routing evidence rather than native-identity authority.
- Ignore closed detached Codex companions when one exact current rollout is open, and release completed Claude Turns for a fresh message ID while retaining immutable acceptance receipts.

### Changed

- Publish action contract 14. Store writer protocol remains 5.

### Security

- Revalidate candidate inventory, terminal and process identity, abandonment proof, and source/target lineage before input, commit, and crash recovery; ambiguous, drifted, or uncertain native acceptance remains non-retryable.

## 0.12.6 - 2026-08-12

### Added

- Add manual-only terminal-scoped Codex approval for one exact visible prompt when a human-entered task has no AKK dispatch owner or usable foreground UUID, while requiring a fresh list token, status fingerprint, and explicit confirmation.

### Fixed

- Let an advertised ordinary Codex task proceed once in a narrow pane when AKK has a complete but foreground-unbound rollout inventory, then bind only the rollout that uniquely accepts the exact request without an internal `/status` probe.
- Reconcile callbackless terminal completion locally, release the exact dispatch ledger, and restart pending candidate monitors after a crash without creating a Gateway outbox or replaying terminal input.

### Changed

- Publish action contract 12 and Store writer protocol 5. Protocol 4 Stores upgrade through an atomic manifest-only writer fence.

### Security

- Freeze released predecessor Turn history throughout deferred candidate binding, preserve separate same-UUID and different-UUID Session lineages, and keep zero, multiple, drifted, or uncertain request acceptance non-retryable.
- Revalidate manual approval and cancellation against the canonical terminal endpoint, process incarnation, dispatch snapshot, Session revision, and prompt immediately before terminal keys, while keeping auto-approval and provisional managed controls unavailable.
- Serialize deferred recovery as terminal-to-writer-to-state and treat Store or state-lock contention as monitor backoff rather than native-acceptance uncertainty.

## 0.12.5 - 2026-08-12

### Fixed

- Let an advertised terminal-scoped ordinary Codex first task proceed in a narrow pane without an internal `/status` probe when the existing status-card-only context has a verified zero rollout, then bind the new AKK Session to the exact rollout that accepts the request.
- Preserve strict UUID proof for explicit Session sends, responses, approvals, cancellations, lifecycle operations, and native inspection while keeping uncertain terminal input non-retryable.

### Security

- Isolate deferred foreground sends in a zero-UUID provisional Session and require exact process, terminal, request-acceptance, ownership, and binding-generation evidence before promoting it to the native thread.
- Add Store protocol 4 writer fencing plus crash-safe deferred-transfer receipts and recovery across pre-input aborts, post-input uncertainty, same-thread handoff, acceptance backfill, and downgrade attempts without replaying terminal input.

## 0.12.4 - 2026-08-11

### Fixed

- Submit every internal Codex `/status` through one exact-version closed path with bracketed-paste settling, current-composer proof, one Enter, and same-depth freshness, so narrow or stale Herdr screens cannot masquerade as a complete current Session.
- Stop uncertain terminal dispatches from collateral-stalling already completed Claude Turns, and strictly repair legacy false stalls only when completion, callback, dispatch-fence, and closed-owner evidence agree.
- Preserve exact Claude composer text across Herdr visual soft wraps while ignoring historical prompts outside the current bottom composer frame.

### Security

- Fence Codex status probes with exact tmux or kernel PTY viewport evidence, terminal route, process birth, TTY device identity, native identity, and final composer revalidation before the single Enter.
- Apply terminal-incarnation blockers consistently across list, send, lifecycle, and native inspection, while keeping human-handoff source Turns behind snapshot-bound close decisions and retaining typed Store-only close for genuinely unavailable terminals.

## 0.12.3 - 2026-08-11

### Fixed

- Recover a same-process Codex terminal after the previously bound rollout has conclusively ended by detaching the old Session and creating a separate virgin Session for the next exact terminal-scoped send.
- Parse only Claude Code's current bottom composer frame, so a historical `/clear` prompt does not block Herdr handoff and exact soft-wrapped drafts can still receive one verified Enter.

### Security

- Keep generic unverifiable native identity and explicit Session-scoped sends fail-closed, while requiring the exact endpoint, PID, process birth, cwd, owner, source binding, idle state, and styled-empty composer before adopting a verified zero-rollout Codex context.
- Preserve character-exact draft checks, repeated pre-text and pre-Enter identity revalidation, single-Enter dispatch, isolated Session history, and no blind retry after text may have reached the terminal.

## 0.12.2 - 2026-08-11

### Added

- Let terminal-scoped sends absorb an exact, verified native-thread switch made by a human through Codex or Claude Code, including `/clear`, new-thread, and Resume flows across tmux and Herdr.
- Restore a uniquely matching historical Session with its own binding generation, or create a separate Session for a previously unseen native thread, without merging conversation history.

### Changed

- Keep explicit Session-scoped sends pinned to their original native context, while active Turns expose a snapshot-bound handoff decision that requires explicit confirmation before the current human context is adopted.

### Security

- Revalidate the native UUID, process birth, terminal endpoint, cwd, exclusive ownership, idle state, and exact composer immediately around terminal input, while preserving single-Enter and no-blind-retry guarantees.
- Persist human-observed handoffs through fenced lifecycle transitions and ledgers with crash recovery, stale-decision rejection, and strict isolation for prior Turns, monitors, callbacks, approvals, and dispatch receipts.

## 0.12.1 - 2026-08-11

### Fixed

- Allow a genuinely virgin Codex TUI to accept its first AKK send by pinning the exact process incarnation before input, then atomically refining the Session and Turn to the newly materialized native UUID, rollout, and request evidence after the single Enter.
- Recover both post-Enter virgin-binding crash windows without replaying terminal text or Enter, while preserving the existing ownership, binding-generation, process, pane, cwd, rollout, and request-hash fences.
- Preserve tmux `pane_current_path` when extended eight-field pane output is collapsed to whitespace or underscores, rejecting ambiguous or truncated records instead of appending the server socket and pane ID to the workspace.
- Preserve Codex composer ANSI styling through Herdr's visible screen buffer so an empty dim placeholder is not mistaken for authored draft text, while leaving ordinary monitor and status reads on Herdr's agent-aware detection buffer.

## 0.12.0 - 2026-08-10

### Added

- Add exact local Herdr `0.8.0` / protocol 19 support as a second terminal provider alongside tmux, including discovery, screen capture, bracketed-paste-aware text delivery, key dispatch, lifecycle state, Resume snapshots, native inspection, monitoring, and OpenClaw actions.
- Add a routed terminal-provider registry, Herdr-aware doctor diagnostics, packaged setup documentation, and provider-neutral terminal identities throughout the Store and public terminal list.

### Changed

- Split the CLI entrypoint from its injectable command core, move the slowest lifecycle and rollout semantics into deterministic in-process fixtures while retaining their real-process contract tests, and add a fail-closed affected-test runner for faster local iteration.
- Isolate terminal-provider discovery and diagnostics failures so an unavailable Herdr session contributes no candidates without hiding healthy tmux terminals.

### Security

- Bind Herdr control to the local Unix-socket incarnation, stable `terminal_id`, refreshable pane route, shell and agent process ancestry, cwd, native coding-agent identity, and the existing Session/Turn binding fences before every side effect.
- Preserve the durable `prepared → text_injected → enter_dispatched → agent_accepted` boundary, keep lost acknowledgements uncertain without blind retries, fail closed when multiple providers could own one process, and isolate a failed provider discovery without hiding healthy transports.

## 0.11.7 - 2026-08-10

### Changed

- Establish a provider-neutral terminal-control boundary that separates stable endpoint/resource identity, mutable delivery routes, and process-incarnation evidence while preserving the existing tmux CLI, OpenClaw tools, and agent lifecycle behavior.
- Route terminal discovery, capture, text injection, and key delivery through an injectable provider registry with fresh resource resolution and explicit transport capabilities.
- Derive binding tokens, terminal locks, dispatch ledgers, receipts, approval fingerprints, and Resume snapshots from one canonical endpoint identity, while monotonically refining existing v0.11.x records and atomically promoting legacy ledgers without duplicate owners.

### Security

- Fail closed when provider identity, process anchors, or required capabilities cannot be revalidated, and preserve the distinction between input proven not sent and a potentially submitted uncertain outcome without blind retries.
- Use stable tmux server/socket and pane identities for namespace isolation and route-renaming safety while retaining exact legacy binding-token and approval-fingerprint compatibility boundaries.

## 0.11.6 - 2026-08-10

### Added

- Add exact lifecycle and native `/status` behavior profiles for Codex 0.147.0 and Claude Code 2.1.226 while preserving Codex 0.146.0/0.146.1 and Claude Code 2.1.218 support.
- Let Claude Code 2.1.226 discover and exactly resume same-workspace 2.1.218 history through source-version-bound v2 candidate tokens and the existing full UUID, ownership, binding, and identity fences.

### Fixed

- Match Codex 0.147.0's exact ordered two-row `/status` completion surface and Claude Code 2.1.226's `Session kind: interactive` Status panel.
- Keep Claude native inspection closed and reliable across narrow panes by accepting only exact profiled rows or their explicit Unicode-ellipsis prefixes, with a version-owned bounded settle deadline before the single Enter dispatch.

## 0.11.5 - 2026-08-09

### Added

- Extend the closed `native_inspect(status)` action to exact Claude Code 2.1.218 with an adapter-owned `/status` plan, a separately measured 80 ms composer-stability boundary, bounded and redacted Status-panel parsing, and safe return to the original idle composer.

### Security

- Fence Claude inspection with a fresh snapshot token, the shared terminal lock, exact pane, PID, process birth, cwd, binding, unique `claude agents --json --all` Session identity, and exclusive active ownership before and across terminal input.
- Keep ordinary `send` and `respond` slash-command rejection intact, issue at most one Enter and one Escape without blind retries, create no AKK lifecycle state, and leave `/usage`, `/cost`, `/stats`, and `/usage-credits` unavailable.

## 0.11.4 - 2026-08-09

### Added

- Add an adapter-owned, version-scoped native status inspection for Codex 0.146.0 and 0.146.1, exposed through a closed `native_inspect(status)` action that returns a bounded and redacted fresh `/status` result without creating a Session, Turn, receipt, monitor, callback, or Store state.

### Security

- Keep ordinary `send` and `respond` slash-command rejection intact while serializing native inspection with terminal mutations, revalidating the exact terminal, process, binding, version, idle composer, and ownership state, and dispatching at most one Enter only after the versioned 121 ms materialization boundary.
- Fail closed after identity drift, ambiguous or stale status evidence, and uncertain submission outcomes without blind retries or a second Enter.

## 0.11.3 - 2026-08-08

### Fixed

- Make virgin Codex raw-terminal attachment atomic by persisting its managed Session only after read-only pre-input checks pass, then CAS-detaching the provisional binding after every conclusively pre-input failure so a failed first send cannot strand a bound orphan.
- Add exact snapshot-fenced `reconcile-binding` recovery for eligible provisional and same-process external-thread conflicts while keeping ambiguous identity, PID, Turn, transition, and dispatch cases fail-closed and suppressing control actions that are already known to fail.
- Distinguish definite tmux no-input failures from uncertain submission outcomes so safe retries remain available without risking duplicate terminal injection.

## 0.11.2 - 2026-08-08

### Fixed

- Filter Codex resume candidates by workspace, source, archive state, and provider before applying the SQLite result limit, so older same-workspace threads are not dropped by unrelated global history.
- Keep the current adapter version separate from each candidate's source agent version, allowing historical Codex threads to remain resumable when their rollout metadata agrees while preserving the complete snapshot, ownership, binding, and identity safety fences.

## 0.11.1 - 2026-08-07

### Fixed

- Harden Codex resumable-thread discovery across transient SQLite WAL/SHM creation, replacement, and checkpoint windows with one read transaction, identity-checked bounded `SQLITE_CANTOPEN` recovery, and a query-only sidecar-materialization fallback that does not use `immutable=1`.
- Forward configured `codexHome` to Codex lifecycle discovery, new, and resume paths in OpenClaw tools and `/akk` commands.

## 0.11.0 - 2026-08-07

### Added

- Add snapshot-bound native Resume navigation with deterministic numbers, collision-safe display-only short IDs, opaque five-minute handles, and a `previous` / `刚才那个` shortcut derived from the current Session's latest committed lifecycle transition.

### Security

- Resolve every Resume shortcut back to the complete UUID and exact evidence tuple, then fail closed if the terminal action generation, process, workspace, binding, ordered candidate snapshot, ownership, or TTL changed before native input.

## 0.10.4 - 2026-08-07

### Fixed

- Recognize exact Codex multiline drafts across TUI-painted visual wraps before dispatching Enter once, while preserving authored newlines, indentation, repeated spaces, stable-capture checks, and fail-closed content drift detection.

## 0.10.3 - 2026-08-07

### Added

- Supervise active terminal bridge monitors from the OpenClaw plugin every five seconds and automatically recreate an unexpectedly exited owner without requiring `list` or `status`.
- Retain redacted durable-completion detector limitation and recovery diagnostics in each Turn's event history.

### Fixed

- Treat Store writer-lock timeouts as transient monitor deferrals with bounded backoff while preserving the hard fence for a genuinely superseded Session binding generation.
- Complete accepted Codex turns from their exact bound rollout and native turn UUID beyond the legacy recent-turn window, while preserving the existing exactly-once completion claim across recovery.

## 0.10.2 - 2026-08-07

### Fixed

- Require exact post-anchor Codex rollout or owner-private Claude transcript evidence before reporting a terminal submission as delivered; tmux transport success alone now remains pending or uncertain and is never automatically retried.
- Track durable `prepared → text_injected → enter_dispatched → agent_accepted` proof, preserve that exact proof level across replay and recovery, and fence stable OpenClaw retries to their original Store, Session, Turn, message, binding, and terminal incarnation.
- Settle an exact multiline Codex composer before dispatching Enter once, promptly report an unchanged exact draft as not accepted, and extend the opt-in lifecycle smoke payload to verify multilingual multiline native acceptance.
- Keep append-only submission receipts bound to the pane incarnation that received their input while allowing a replacement tmux pane to establish a new dispatch generation.

## 0.10.1 - 2026-08-06

### Added

- Add an opt-in native lifecycle live-smoke diagnostic that records redacted, commit-bound Codex and Claude Code `new → send → resume` evidence.
- Add an exact Codex 0.146.1 native lifecycle behavior profile while preserving 0.146.0 support.

### Fixed

- Let the lifecycle diagnostic attest a persisted unmanaged Codex 0.146.1 thread whose identity is first proved by New's locked, fresh `/status` probe, then fail before `/clear` unless that exact origin remains a uniquely owned, revalidated resume candidate; ordinary list and New behavior remain unchanged outside the opt-in diagnostic.
- Keep the semantic Turn phase independent from callback transport delivery, so a failed or pending `done` notification leaves the Turn idle and a failed or pending `question` or `blocked` notification remains actionable through respond or cancel.
- Treat accepted OpenClaw injection and wake acknowledgements as durable delivery while keeping `agent.wait` timeout, error, or malformed output as observation-only evidence that cannot replay an accepted callback.
- Serialize callback claims with exact in-flight diagnostics, preserve immutable outbox delivery across close and Session binding-generation changes, and migrate valid legacy callback-owned statuses without letting malformed records poison Store-wide listing.

### Changed

- Keep the native lifecycle smoke optional during rapid iteration: npm and ClawHub publishing no longer require an annotated-tag attestation, while the manual runner and evidence verifier remain available for diagnostics.

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

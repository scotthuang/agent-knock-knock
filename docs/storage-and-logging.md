# Storage and Logging

AKK keeps managed state in `~/.agent-knock-knock/store` by default. The Store
contains its compatibility manifest, authoritative Sessions and Turns,
independent Terminal Watch records, dispatch receipts, callback outboxes, and
event logs. It may therefore contain terminal and task metadata and should
remain private.

## Filesystem safety

- Store directories use mode `0700`.
- State and event-log files use mode `0600`.
- Durable JSON writes are atomic and do not follow symbolic-link targets.
- A custom Store must be a dedicated directory. AKK refuses a non-empty
  manifestless directory rather than adopting unknown files.
- The Store manifest fences incompatible managed writers before managed
  terminal or callback mutations. An eligible explicit physical Send retains
  its separate runtime receipt and input-safety checks; it cannot mutate an
  incompatible managed Store.

## Compatibility manifest

The manifest checks storage format and writer behavior separately. An unknown
`format_version` is not read. The current writer protocol is 9; writer
protocols 1 through 8 are supported predecessors and inspection reports them
as `upgradeable`.

Upgrading protocol 1 or 2 validates predecessor Turn records,
deterministically derives and durably materializes authoritative Session
records, quarantines ambiguous Session bindings, and finishes by atomically
publishing protocol 9. Existing Turn state, event logs, and the original
manifest `created_at` remain unchanged.

Protocols 3 through 8 already have Session authority, so their upgrade is an
atomic manifest-only writer fence with no data migration. Protocol 6 prevents
older writers from rejecting or damaging schema-v2 Terminal Watch records.
Protocol 7 fences the `interaction_manual_required` notification kind from
protocol-6 writers. Protocol 8 protects paginated task anchors and private
multi-question checkpoints from older writers. Terminal Watch schema v3 separately adds interaction
policy, subject-aware projection, one-shot reservation, and callback-outbox
state; its version fence makes older strict Watch decoders reject the record
instead of rewriting unknown authority. Legacy schema-v1/v2 Watches are
normalized to `notify_only`; they never silently acquire terminal response
authority. Downgrading after v3 records exist is not supported. Core
Session/Turn data remains readable across a writer-protocol mismatch, while
explicit reconciliation reports `skipped` and managed mutations fail before
terminal or Host side effects. This does not prohibit an independently
authorized physical Send that leaves managed state untouched.

## Conversation routing journal

Backend-first Send records its chosen provider before task delivery. These
records live under the private runtime directory (`~/.agent-knock-knock/runtime-v2`
by default, or `AKK_RUNTIME_DIR`), in `conversation-routing/<store-path-hash>/state`.
They have their own locks and compatibility manifest; they do not acquire the
managed Store's writer lock. A reused message ID stays on its original provider,
even if another route becomes available later.

Development builds that wrote these records under the managed Store are read
without modifying the old records. Their original route and any recorded outcome
remain authoritative; conflicting journals stop the request. A replayed receipt
is the original submission observation. Query Status for current task state.

## Legacy directory

The former `~/.agent-knock-knock/conversations` directory is left untouched.
AKK does not read or migrate it. Existing Codex and Claude Code terminals remain
discoverable, but legacy managed-turn IDs, callback associations, and old
conversation aliases are not imported into the stable Store.

## Logs and retention

Runtime logs redact common secret forms and default to 14-day retention. The
main controls are:

| Control | Purpose |
| --- | --- |
| `--store-dir` | Use a dedicated Store for standalone CLI operations. |
| `AKK_LOG_DIR` | Select a dedicated runtime log directory. |
| `AKK_LOG_LEVEL` | Set the emitted log level. |
| `AKK_LOG_RETENTION_DAYS` | Change the retention window. |

Do not point a custom Store or log directory at a broad home, workspace, or
shared directory. Review retained callback and terminal data before any manual
cleanup. AKK does not delete coding-agent transcripts, Codex rollouts, tmux or
Herdr sessions, or model credentials.

OpenClaw-specific `storeDir` configuration and operational diagnostics are in
[OpenClaw Operations](openclaw-operations.md). The full Session, Turn, Watch,
and callback identity contract is in the
[Terminal Handoff Protocol](bidirectional-agent-protocol.md).

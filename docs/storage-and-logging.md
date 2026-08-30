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
- The Store manifest fences incompatible writers before any terminal or
  callback mutation.

## Compatibility manifest

The manifest checks storage format and writer behavior separately. An unknown
`format_version` is not read. The current writer protocol is 6; writer
protocols 1 through 5 are supported predecessors and inspection reports them
as `upgradeable`.

Upgrading protocol 1 or 2 validates predecessor Turn records,
deterministically derives and durably materializes authoritative Session
records, quarantines ambiguous Session bindings, and finishes by atomically
publishing protocol 6. Existing Turn state, event logs, and the original
manifest `created_at` remain unchanged.

Protocols 3, 4, and 5 already have Session authority, so their upgrade is an
atomic manifest-only writer fence with no data migration. Protocol 6 prevents
older writers from rejecting or damaging schema-v2 Terminal Watch records. Any
other writer-protocol mismatch remains readable for normal queries, while
explicit reconciliation reports `skipped` and every mutation fails before
terminal or Host side effects.

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

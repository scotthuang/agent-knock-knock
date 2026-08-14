# Orchestration refactor architecture baseline

Status: accepted starting point for [issue #126](https://github.com/scotthuang/agent-knock-knock/issues/126)

Snapshot: `main@ea592a88d7af4a709e7a7a1b989dd29e61932935` / `v0.12.11`, measured 2026-08-14

Machine-readable measurements: [orchestration-baseline.json](./orchestration-baseline.json)

## Purpose

This document defines the boundaries, dependency direction, transaction rules,
and compatibility contract for the incremental orchestration refactor. It is a
design constraint for the PR sequence, not a claim that the current source tree
already satisfies the target architecture.

The objective is to make ordinary product changes local and reviewable while
preserving AKK's safety model. `src/cli-core.ts` must become a stable command
facade over typed services instead of remaining the owner of terminal authority,
dispatch, lifecycle, monitor, callback, persistence, and recovery state machines.

This work is a strangler refactor. Each PR extracts and characterizes existing
behavior behind a typed boundary before callers switch to that boundary. A
ground-up rewrite, protocol redesign, or safety simplification is out of scope.

## Current baseline and concentration

The production scope is the 38 checked-in `src/**/*.ts` files. Tests, generated
`dist`, scripts, templates, and vendored dependencies are excluded.

| Metric | Current baseline |
| --- | ---: |
| Production physical LOC | 73,792 |
| Functions/methods with bodies | 2,449 |
| Files over 1,000 LOC | 16 |
| Functions over 100 LOC | 167 |
| Functions over 200 LOC | 57 |
| Functions over 500 LOC | 9 |
| Approximate complexity over 20 | 150 |
| Production import cycles | 0 |

`src/cli-core.ts` is the dominant risk concentration:

| Metric | `src/cli-core.ts` |
| --- | ---: |
| Physical LOC | 38,005 (51.5% of production source) |
| Functions/methods with bodies | 913 |
| Functions over 100 / 200 / 500 LOC | 116 / 43 / 8 |
| Approximate complexity over 20 | 98 |
| Import declarations | 37 |
| Distinct internal modules imported | 30 |
| `Record<string, any>` type references | 246 |
| Functions receiving an `options` bag | 152 |
| Distinct `options.<property>` names | 117 |
| Durable mutation calls | 204 |
| Lock or writer-lease acquisition calls | 91 |

The largest current paths are:

- `runTerminalControlSend` at `src/cli-core.ts:19838`: 1,886 lines,
  approximate complexity 242.
- `runTerminalBridgeMonitorWithLock` at `src/cli-core.ts:27647`: 1,444
  lines, approximate complexity 203.
- `terminalFirstListProjection` at `src/cli-core.ts:4931`: 1,283 lines;
  its terminal projection callback is 1,162 lines with approximate complexity
  302.
- `runNativeThreadTransition` at `src/cli-core.ts:16516`: 812 lines; its
  transaction callback is 790 lines.
- `runSend` at `src/cli-core.ts:18077`: 721 lines.
- `runApprove` at `src/cli-core.ts:19041`: 635 lines.

The problem is concentrated orchestration, not uniform source quality. The
import graph is currently acyclic and the public imported surface of
`cli-core.ts` is small, so behavior can be replaced behind that facade without
forcing consumers to migrate in one step.

The test cost is similarly concentrated. At the `v0.12.11` baseline, 71
TypeScript test files contain 71,902 physical lines. Three clean fast-tier runs
at concurrency four completed in 8.68, 8.70, and 8.85 seconds (median 8.70
seconds). Two clean integration-tier runs took 922.01 and 985.75 seconds; one
was green and one exposed the pre-existing monitor-singleton supersession
timeout. In both runs, `test/codex-no-rollout-binding-cli.test.ts` alone took
921.81–985.56 seconds. Refactoring success therefore requires narrower affected
selection and lighter deterministic fixtures, not fewer safety invariants.

## Architectural vocabulary

- **Facade**: stable CLI-facing API that parses a command, selects a handler,
  formats output, and maps failures to the existing process contract.
- **Observation**: immutable facts sampled from Store, terminal, process, agent,
  and transcript sources. An observation is evidence, not durable authority by
  itself.
- **Authority decision**: a pure, typed allow/deny/recovery result derived from
  an observation and a specific operation. It carries exact reasons and the
  snapshot-bound tokens required for later revalidation.
- **Use case**: one command-level orchestration operation such as send, approve,
  new thread, callback delivery, or one monitor step.
- **Transaction shell**: the only layer allowed to acquire mutation locks,
  perform CAS writes, and execute ordered durable effects.
- **Port**: a typed interface used by a use case for time, Store, terminal,
  process, transcript, or callback transport access.
- **Adapter**: an implementation of a port. Codex-, Claude-, tmux-, Herdr-,
  filesystem-, and OpenClaw-specific behavior belongs here.

## Target module ownership

The path names below describe ownership. A PR may choose nearby names, but it
must preserve the responsibility and dependency rules.

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `cli.ts` | Process argv, stdout/stderr forwarding, process exit | Business decisions, Store or terminal access |
| CLI runtime and command registry | Per-execution context, typed parsing, command registration, output envelope | Terminal authority, lifecycle or callback state machines |
| `cli-core.ts` | Compatibility exports `parseCliCommand` and `executeCliCommand`; temporary routing shims | New state machines, new persistence codecs, new direct lock code |
| Terminal observation | Typed terminal/process/agent snapshots and normalization | Permission decisions or mutations |
| Authority and action projection | Binding match/conflict, ownership, selectors, tokens, `available_actions`, handoff decisions | I/O, clocks, filesystem paths, terminal input |
| Persistence repositories/codecs | Backward-compatible decoding, validation, atomic write primitives, revisions and CAS | Product policy or terminal input |
| Transaction/lock kernel | Canonical lock acquisition/release and per-transaction capabilities consumed by gated mutation ports | Business decisions, durable effect ordering, command parsing, or agent-specific screen logic |
| Dispatch service | Send/respond/approve/cancel preparation, exact input stages, acceptance receipt decisions | CLI formatting, callback transport, native-thread lifecycle policy |
| Lifecycle service | New/resume/adopt/reconcile classifications and transition reducer | Ordinary task submission or callback delivery |
| Callback/outbox service | Immutable callback message, attempt lease, retry and delivery settlement | Monitor polling or terminal authority projection |
| Monitor service | Poll scheduling, pure completion/question/approval/stall decisions, reconciliation effects | Gateway transport details or duplicated dispatch policy |
| Agent adapters | Codex/Claude process classification, composer/status/transcript profiles, native identity evidence | Store transactions or CLI response schemas |
| Terminal-control adapters | tmux/Herdr discovery, screen capture, exact terminal mutation | Session/Turn policy or Store writes |
| OpenClaw plugin | Tool schemas, argument mapping, command registration, Gateway integration | A second copy of CLI authority or action projection |

Existing cohesive modules such as `store.ts`, `session-store.ts`,
`terminal-control-provider.ts`, `terminal-agent-adapter.ts`, and agent-specific
adapters are retained behind ports. Extraction may split their codecs from
repositories, but it must not funnel their responsibilities back through the
CLI facade.

## Dependency direction

The allowed direction is:

```text
CLI / OpenClaw entrypoints
          |
          v
typed command facade and composition root
          |
          v
dispatch | lifecycle | callback | monitor use cases
          |
          v
pure authority, action, and state-transition policies
          |
          v
typed domain values and port interfaces
          ^
          |
filesystem, tmux, Herdr, Codex, Claude, and Gateway adapters
```

The arrows represent compile-time dependencies. Infrastructure implements ports
defined inward; domain and use-case modules never import infrastructure or the
CLI facade.

Required rules:

1. No new service may import `cli-core.ts`.
2. Pure policy/reducer modules may not import `node:fs`, `node:child_process`,
   environment access, wall clocks, or sleep functions.
3. `cli-core.ts` and the OpenClaw plugin consume the same action and authority
   result; neither reconstructs permission rules from output fields.
4. Agent-specific composer, native-status, and transcript behavior stays behind
   the agent-adapter boundary.
5. Store codecs accept retained legacy formats at the boundary. Use cases
   consume validated current domain values.
6. The production import graph must remain acyclic. A cycle is a release
   blocker, not an acceptable transitional state.
7. Both `cli-core.ts` physical LOC and total `src/**/*.ts` physical LOC are
   exact ratchets in the ownership manifest. An extraction may lower either
   value, but cannot silently grow it back; any intentional increase requires
   an explicit architecture review and manifest diff.

## Canonical lock order

All newly extracted mutation code uses this acquisition order, skipping a scope
only when that resource is not involved:

```text
terminal dispatch lock -> Store writer lease -> conversation state lock
```

Locks are released in reverse order. An operation must never acquire a lock to
the left while it already holds a lock to the right.

- The terminal dispatch lock serializes all input and lifecycle effects for one
  canonical terminal endpoint/incarnation.
- The Store writer lease fences incompatible writers and serializes mutations
  across authoritative Session, Turn, transition, and transfer records.
- The conversation state lock protects one Turn state/event transaction and its
  compare-before-write checks.

The transaction shell creates fresh opaque terminal, Store-writer, and optional
conversation-state scopes for every invocation. Capability-gated repositories
validate that every required scope is authentic, active, and belongs to the
same transaction and exact canonical terminal, Store, or state resource.
Repositories take their raw target from the verified frozen resource handle,
so a caller cannot pair a valid scope with a different path or terminal.
Scopes expire before lock release begins, so a leaked scope cannot authorize a
later write. Boolean parameters such as
`terminalSendLockHeld`, `terminalStateLockHeld`, and `storeWriterLeaseHeld` must
not be reproduced in new services.

Read-only observation must not take mutation locks merely for convenience.
Before a side effect, the transaction shell re-observes and revalidates exact
endpoint, process incarnation, binding generation, owner, composer, approval,
and snapshot/token authority under the required locks.

### Current lock-order exceptions

The canonical order above is a target constraint, not a statement that every
`v0.12.11` path already conforms. Known structural exceptions at the baseline
include:

- `runTerminalControlSend` (`src/cli-core.ts:19838`) can express
  terminal -> state -> writer through recursive `*LockHeld` flags.
- `runTerminalControlCancel` (`src/cli-core.ts:26274`) acquires terminal, then
  state, then enters the writer lease.

Behavior-preserving extraction must inventory every reachable exception. It may
wrap an existing order temporarily, with a named compatibility note and focused
deadlock/crash tests, but it must not add another instance. Reordering an
existing transaction is a separate focused change with proof at every durable
write boundary; it must not be hidden inside a file move.

## Transaction phases

### Ordinary terminal dispatch

The target dispatch transaction is explicit and monotonic:

1. **Resolve**: select the exact Session/Turn/terminal and capture observations.
2. **Authorize**: derive one typed authority decision and required token set.
3. **Lock and revalidate**: acquire terminal -> writer -> state and prove the
   same endpoint, owner, process incarnation, binding generation, request, and
   composer boundary.
4. **Prepare**: persist the immutable request identity and `prepared` dispatch
   ledger before terminal input.
5. **Inject text**: record `text_injected` only after exact text injection is
   acknowledged.
6. **Dispatch Enter**: send exactly one Enter and durably record
   `enter_dispatched`. Legacy `submitted` is compatibility evidence for this
   stage, not proof of native acceptance.
7. **Observe acceptance**: record `agent_accepted` only with exact supported
   native evidence. Record `not_accepted` or `uncertain` when that is what the
   evidence proves.
8. **Commit and monitor**: commit Session/Turn/binding effects and start or
   reconcile the monitor from durable state.

Before input, a proven rollback may end as `aborted` with `safe_to_retry=true`.
After input may have begun, ambiguous outcomes are `uncertain` with
`do_not_retry=true`. No extraction may collapse these two cases.

### Native-thread lifecycle

New, resume, and adopted external handoff use a separate transition state
machine:

```text
prepared -> dispatching -> submitted -> verified -> committed
                |              |           |
                +----------> uncertain <---+
                |
                +----------> aborted  (only with zero-input proof)
```

`prepared` transition and lifecycle ledger records precede terminal input.
`verified` requires exact postcondition identity. Session binding changes commit
with revision/CAS evidence before the lifecycle ledger becomes `resolved`.
Human-observed adoption is evidence and must never replay terminal input.

### Deferred foreground transfer

The Codex follow-current path retains its own durable transfer receipt:

```text
prepared -> source_reserved -> target_prepared -> dispatch_started
          -> committed -> resolved
```

Its input substage is monotonic:

```text
none -> dispatch_started -> text_injected -> enter_dispatched -> agent_accepted
```

Only zero-input proof may reach `aborted`/`abort_resolved`. Possible input with
an unproved outcome reaches `uncertain`; recovery may later prove and commit the
same dispatch but may not send it again.

### Callback/outbox

1. Prepare one immutable callback message and deterministic id.
2. Persist pending outbox state and an attempt lease before transport.
3. Deliver through the current OpenClaw Gateway adapter.
4. Persist transport progress/acceptance.
5. Settle delivered final state, or persist retryable failure and next attempt.
6. Reconciliation resumes only the same message/attempt authority.

Callback transport state does not own or rewrite the semantic Turn phase.
Cross-Session callback delivery remains strictly isolated.

### Monitor step

A monitor iteration becomes `observe -> decide -> execute effects -> persist`.
The decision is pure and may yield wait, diagnostic, approval notification,
question, completion claim, verified-dead stall/close recovery, timeout stall,
or dispatch-ledger reconciliation. The I/O shell is responsible for locks and
idempotent effect execution. Polling never becomes authority to replay input.

## Durable write points

The following records are externally observable recovery authorities. Their
ordering and compatibility are behavior, not implementation detail.

| Durable record | Current location | Authority retained during extraction |
| --- | --- | --- |
| Store manifest | `<store>/manifest.json` | Format/writer compatibility and writer fencing |
| Managed Session | `<store>/sessions/<session>/state.json` | Binding, native identity, revision/CAS, lineage |
| Turn/conversation state | `<store>/conversations/<turn>/state.json` | Semantic Turn phase, submission receipt, callback outbox |
| Turn event log | `<store>/conversations/<turn>/events.ndjson` | Append-only audit and recovery evidence |
| Native transition | `<store>/transitions/<transition>/state.json` | Lifecycle generation, input outcome, verification and commit |
| Deferred foreground transfer | `<store>/deferred-foreground-transfers/<transfer>/state.json` | Follow-current reservation, input stage, commit/abort authority |
| Terminal dispatch ledger | `<runtime-v2>/terminal-dispatch/terminal-dispatch-<key>.json` | Terminal-wide input owner and strongest transport receipt |
| Terminal/monitor lock files | `<runtime-v2>/terminal-locks` and monitor lock paths | Live serialization only; never semantic authority by themselves |

For every extracted transaction, the PR must include a durable write map that
states:

- the precondition and held lock scopes (and, once enforced by a gated port,
  capabilities);
- the record and expected revision/generation;
- whether terminal input is definitely zero, possible, or accepted;
- the crash point immediately before and after the write;
- the single allowed reconciliation direction;
- whether retry is safe, forbidden, or requires explicit recovery authority.

The strongest durable proof is never overwritten by weaker observation. Event
write failure after a stronger state/ledger commit is reconciled as lagging
audit, not by downgrading the committed fact.

### Transaction capability write map

PR3 applies the kernel only to operations that already use the target lock
order. Their business callbacks remain in `cli-core.ts`; the kernel owns scope
authenticity and lifetime, not these records or effects.

| Repository boundary | Required capabilities | Composition adapter retained |
| --- | --- | --- |
| Conversation state load / save / event append | state / writer + state / writer + state | existing Store filesystem and JSON functions |
| Terminal dispatch-ledger load / save / resolve / reconcile | terminal / terminal + writer | existing runtime-ledger filesystem and lifecycle reconciliation functions |
| Managed Session load / CAS save | writer | existing Session repository functions |

Lifecycle recovery and reconciliation receive both the exact locked terminal
and canonical Store path from a paired repository capability. A recorded
`store_dir` is comparison evidence only: a mismatch fails closed before any
transition read, quarantine, Session write, or lifecycle-ledger resolution.

| Operation | Held lock scopes | Durable writes and existing order | Terminal input | Crash/retry direction |
| --- | --- | --- | --- | --- |
| `runReconcileBinding` | terminal -> writer | one managed Session CAS detach at the listed revision | definitely zero | before CAS, refresh and reauthorize; after CAS, detached is final and a stale token cannot retry |
| `runTerminalConversationCancel` | terminal -> writer | none; runtime audit and JSON output remain after the adapter call | possible ordered cancel keys | before input, a fresh cancel may retry; after an unacknowledged transport attempt, adapter semantics remain authoritative |
| `runObservedHandoffClose` | terminal -> writer -> state | Turn state `closed` -> exact dispatch-ledger resolution -> close event | definitely zero | advance only toward ledger/event reconciliation; stale handoff authority cannot start a second close |
| `runTerminalDispatchClose` | terminal -> writer | lifecycle reconciliation keeps its existing writes; orphan recovery writes one exact dispatch-ledger generation as `resolved` | definitely zero | advance only toward resolved; refresh is required after the recorded generation changes |

Each callback continues to perform the same observations, compare-before-write
checks, output, and error text under the same lock scopes. Handoff close routes
its fresh Turn/Session/ledger loads, state save, ledger resolution, and event
append through the gated repositories. Dispatch close routes its
pane-incarnation load/resolution and later reconciliation writes through them;
binding reconciliation uses
the managed-Session adapter for its fresh reads and CAS detach. The transaction
module supplies no effect DSL and cannot construct Store or protocol state.
Native-transition and raw/managed-send entry points use the same paired
capability for lifecycle-fence recovery; unrelated dispatch and lifecycle
writes remain in their existing shells for their later service milestones.

### Initial native-thread transition policy slice

PR5a introduces `native-thread-transition-policy.ts` as a 297-line pure typed
decision module. It owns lifecycle capability eligibility, exact resume
candidate and target-Session decisions, explicit binding-reconciliation
eligibility, prepared transition construction, the six in-memory transition
phase projections, and the durable failure-phase priority. `cli-core.ts`
remains at its 37,873-line ratchet: this first slice moves one authority source
without using formatting changes to claim a size reduction.

The module has only type dependencies on managed Session/transition state and
terminal identity. It imports no filesystem, process, terminal-control, Store,
clock, or lock implementation. The shell still owns every public error string,
terminal/process observation, token comparison input, clock read, and effect.
The existing `terminal -> Store writer` lock scope is unchanged. Durable order
also remains transition `prepared` before lifecycle ledger `prepared`, each
transition phase CAS before its matching ledger phase, target ownership proof
before commit, and verified Session commit before transition/ledger resolution.

The focused fast table covers new/resume construction (including null versus
existing target revision), all six phase events, failure priority, candidate
and target eligibility, and reconciliation. Affected-test selection binds this
module to `codex-no-rollout-binding-cli`, `human-handoff-adoption-cli`,
`native-thread-lifecycle-cli`, and `native-thread-lifecycle-recovery-cli`.

### Initial dispatch-ledger codec slice

PR4b introduces `terminal-dispatch-ledger-codec.ts` as a pure document codec
and append-only receipt reducer. It owns v1/v2 in-memory document validation,
lifecycle-document classification, receipt history validation/candidate
projection/strength-preserving merge, and construction of the next JSON
document. This lowers `cli-core.ts` from 37,809 to 37,481 physical lines.

The shell still chooses canonical and legacy runtime keys and paths and owns
every filesystem observation and effect: dual-path conflict checks, symlink and
regular-file fences, reads, promotion rename, directory fsync, exclusive temp
creation, chmod, write/fsync, atomic rename, and cleanup. The codec receives
already-read bytes and precomputed document identity. Native `JSON.parse`
failures, invalid-ledger text, v1/v2 field presence and insertion order,
historical terminal-incarnation evidence, immutable receipt fields, strongest
receipt proof, and the one proven-safe abort retry generation remain unchanged.

Focused tables characterize malformed and duplicate histories, every lifecycle
discriminator and receipt status, immutable-field and terminal-incarnation
conflicts, proof downgrade prevention, safe-abort chronology, and v1/v2 JSON
ordering. The affected integration map covers dispatch authority, recovery,
receipt fences, terminal send gates, control locks, Codex no-rollout binding,
handoff adoption, and native lifecycle recovery.

### PR4B1 dispatch receipt and application seam

PR4B1 introduces `terminal-dispatch-receipt.ts` for pure terminal bridge state
and append-only receipt construction and `terminal-dispatch-application.ts` as
a typed application seam for already-authorized ordinary dispatch writes. It
composes the existing ordinary-ledger codec and zero-input abort reducer behind
five local responsibility groups: irreversible-stage synchronization, state,
ledger, domain audit, and pre-input rollback. It imports no CLI option type,
raw JSON or filesystem adapter, lock implementation, terminal transport,
acceptance poller, native binding authority, or public presenter.

Measured against exact head `22a379e60329d19ed884264b532106149116726d`,
this seam lowers `cli-core.ts` from 32,146 to 31,321 physical lines. The
492-line receipt module and 731-line application module bring total production
from 76,076 to 76,474 lines, a reviewed 398-line typed-boundary overhead. The
largest new function is the 164-line receipt reducer; the largest application
method is the 118-line zero-input abort method. All new functions remain below
the hard 500-line and approximate-complexity-50 gates.

PR4B1 deliberately preserves the legacy fallback lock acquisition order:
terminal send lock, Turn-state lock, then Store-writer lease. The composition
root continues to own those locks and supplies raw state, ledger, event,
rollback, clock, and crash-hook adapters. Application ports are invoked only
inside that existing scope and do not expose lock handles or repositories. The
stage synchronization port only copies the staged conversation and irreversible
stage timestamp into local core catch variables before state, ledger, or
deferred/handoff effects; it performs no I/O and cannot escape the invocation.

The composition root also retains terminal input and Enter, acceptance
observation and polling, deferred-transfer and native-binding authority,
collateral stalling, and every CLI/OpenClaw JSON result. Only durable object
construction and ordered application moved:

- prepared remains ledger then state; either failure restores the prior ledger,
  rolls back the provisional raw attach, and rethrows before terminal input;
- each transport stage remains state then ledger, followed by the core-owned
  deferred/handoff boundary, then a best-effort domain event; its irreversible
  progress is synchronized to the core immediately before those effects;
- native identity failure remains core quarantine/deferred marking, ledger,
  state, event, log; generic uncertainty remains ledger, state, event before
  core collateral stalling and presentation;
- final acceptance remains state, best-effort final ledger, then best-effort
  event, so a lagging ledger cannot downgrade the strongest state receipt; and
- zero input remains deferred abort or ledger restore, raw rollback, best-effort
  aborted state, the shared abort reducer, best-effort event, then domain log.

Direct fast proofs compare `Object.keys` and newline-terminated pretty JSON
bytes for the bridge state, prepared receipt, and final ledger. They also lock
the write sequences above, text-stage state/ledger/boundary failures carrying a
`TerminalInputNotStartedError` without being reclassified as zero input,
final-ledger failure behavior, immutable receipt history, and the intentional
authority difference where setup presentation uses the initially constructed
aborted receipt while transport presentation uses the reducer-reported receipt.
The owner map selects exactly recovery, receipt-fence, session-acceptance,
terminal-send, and Codex virgin-binding integration suites. Dispatch-authority
remains a core lock/authority boundary rather than an application owner.

### PR4C canonical dispatch transaction and execution seam

PR4C reuses the PR4B1 application seam as the only implementation of durable
dispatch ordering. Measured against exact head
`7a7987f038ac2d96f6c8dca22dcc07db4d8f1e6c`, it lowers `cli-core.ts` from
30,640 to 29,281 physical lines (-1,359). Total production grows from 76,649
to 77,792 lines (+1,143, 84.11 percent of the core reduction). The reviewed
increase beyond the iteration budget is the exact-resource repair: authentic
cross-Store state scopes, canonical terminal/writer key-value pairs, malformed
resources, raw-attach rollback, and
post-input Session/deferred writes now fail closed before their repository I/O.
The largest remaining dispatch entry stage is 477 lines with approximate
complexity 34;
all new and split functions remain below 500 lines and complexity 50.

Ordinary terminal dispatch now acquires the canonical terminal resource, then
the exact Store writer, and derives any Turn-state scope from that same live
transaction. The state callback is awaited and the capability expires when it
returns. Both the dynamic send path and the static writer/state helper reject a
wrong Store, wrong event log, mixed transaction, released scope, or forged
resource before lock acquisition or filesystem I/O. Application repositories
consume those exact active capabilities for every state, ledger, event, and
rollback operation; they accept no free Store, path, terminal, or lock handle.

`terminal-dispatch-execution.ts` owns preflight, transport lifecycle, native
identity, acceptance, and authority orchestration behind five typed port
groups: clock, native observation, acceptance, terminal proof, and Turn
authority. Codex anchor capture/detection and Claude transcript detection are
implemented by the core-owned adapter; the service has no filesystem, Store,
raw-lock, public-JSON presenter, or concrete terminal-bridge dependency. Its
direct fake-port tables lock short-circuit order, exactly one Enter stage,
before/after-text failure classification, late acceptance and bounded pending
results, native identity outcomes, and Turn revalidation.

Raw terminal input, public CLI/OpenClaw JSON, acceptance adapter construction,
and authority composition remain in `cli-core.ts`. The 82-line
`terminal-dispatch-composition.ts` file is explicitly a temporary CLI
infrastructure type bridge owned by `terminal-dispatch-core`, not an
application service: it still names a concrete resolved terminal type and the
legacy `Record<string, any>` options bag. PR7 must eliminate that bridge while
moving the remaining composition facade; neither type is exposed by the PR4C
execution, application, or capability services.

The `terminal-dispatch-application` owner retains exactly five affected
integration witnesses: Codex no-rollout binding, dispatch recovery, receipt
fences, session acceptance, and terminal send gates. Focused direct tables also
prove the canonical resource identities and the preserved PR4B1 durable write
and error-priority sequences without introducing a second state machine.

## Immutable public and safety contracts

The refactor must preserve all of the following unless a separate product issue
explicitly approves a change.

### Public surfaces

- npm package `@scotthuang/agent-knock-knock` and executable
  `agent-knock-knock`.
- Imported facade functions `parseCliCommand` and `executeCliCommand`, including
  per-execution dependency isolation.
- Existing CLI command names, aliases, arguments, JSON field meanings, stdout,
  and exit behavior. This includes `delegate`, `list`, `status`, `send`,
  `new-thread`/`clear-thread`, `list-resumable-threads`/`threads`,
  `native-inspect`/`native-status`, `resume-thread`, `reconcile-binding`,
  `respond`, `approve`, `cancel`, `renew`, `reconcile-monitors`, `close`,
  `transcript`, `install-openclaw`, `doctor`, `callback`, `retry-callback`, and
  the internal `monitor` entrypoint.
- OpenClaw plugin id `agent-knock-knock`, `/akk`, and these 14 tool names:
  `agent_knock_knock_list`, `agent_knock_knock_list_resumable_threads`,
  `agent_knock_knock_native_inspect`, `agent_knock_knock_new_thread`,
  `agent_knock_knock_reconcile_binding`, `agent_knock_knock_resume_thread`,
  `agent_knock_knock_status`, `agent_knock_knock_send`,
  `agent_knock_knock_respond`, `agent_knock_knock_renew`,
  `agent_knock_knock_retry_callback`, `agent_knock_knock_cancel`,
  `agent_knock_knock_close`, and `agent_knock_knock_approve`.
- The machine-readable `list` action contract, prefilled arguments, selectors,
  and token semantics used by both CLI and OpenClaw.
- tmux and exact-version Herdr support, plus current Codex and Claude adapter
  compatibility behavior.

### Persistence and recovery

- Current and retained legacy Store readability/migration, including Store
  format 1, writer protocol 5, and Session-authority protocol 3 behavior.
- Existing Session, Turn, native-transition, deferred-transfer, dispatch-ledger,
  callback-outbox, and event schemas and their on-disk identities.
- Monotonic Session/transition/transfer revisions, binding-generation CAS, and
  crash recovery.
- Idempotent message, dispatch, completion, and callback identities.
- Strict Store, Session, Turn, terminal-incarnation, and OpenClaw-session
  isolation.

### Terminal safety

- Full native UUID and process-incarnation authority; complete Codex rollout
  identity where required.
- Fresh snapshot, candidate, binding, handoff, approval, and terminal tokens.
- Endpoint, route, pane/resource, PID/process-birth, cwd/workspace, owner,
  approval, idle, and composer fences.
- `prepared -> text_injected -> enter_dispatched -> agent_accepted` evidence;
  exactly one Enter after exact composer proof.
- No blind retry after possible input, uncertain submission, uncertain approval,
  or uncertain lifecycle transition.
- Human input and explicit handoff remain higher priority than stale automation.
- `list` remains read-only unless reconciliation was explicitly requested.
- AKK never starts a coding-agent process.

## Milestones and PR gates

Each milestone is independently reviewable and behavior-preserving. Later work
does not need to wait for every cleanup within an earlier module, but it may not
bypass an unfinished safety boundary.

1. **PR0 — baseline and architecture**: this document, machine-readable
   measurements, current ownership and contract inventory.
2. **PR1 — terminal observation and binding authority**: extract the shared pure
   exact-binding decision first while list and mutation each retain fresh,
   purpose-built observations and mutation revalidation.
3. **PR2 — verified-dead agent and orphan-turn policy**: one pure decision source
   shared by managed close, startup reconciliation, and the direct monitor; keep
   process, transcript, Store, terminal, and callback I/O in their existing shell.
4. **PR3 — repositories and transaction kernel**: typed codecs/ports, lock
   capabilities, durable write maps; initially preserve legacy ordering where a
   documented exception requires it.
5. **PR4 — dispatch service**: send/respond/approve/cancel transaction phases and
   acceptance evidence behind the stable facade.
6. **PR5 — lifecycle service**: new/resume/adopt/reconcile reducer and bounded I/O
   shell, including deferred foreground transfer recovery.
7. **PR6 — callback/outbox and monitor/reconciliation services**: extract these
   as separate reviewable commits behind their existing durable boundaries;
   callback preparation/settlement and monitor polling remain distinct services.
8. **PR7 — typed facade and secondary cleanup**: finish the command registry,
   keep only stable facade exports in `cli-core.ts`, split remaining OpenClaw
   adapter glue, and remove only compatibility shims proven dead by tests.

Every PR records before/after metrics, responsibility movement, dependency
edges, lock order, durable write points, and the focused tests that protect the
moved boundary. No newly extracted function exceeds 500 physical lines or
approximate complexity 50 without a documented exception; the normal target is
under 100 lines and complexity under 20.

The completion target remains:

- `cli-core.ts` at or below 8,000 physical lines and acting only as facade/router;
- no `Record<string, any>` or implicit `any` in new service APIs;
- no direct lock acquisition or JSON persistence in orchestration services;
- one authority/action decision source;
- zero production import cycles;
- unchanged black-box public contracts and full release gate.

## Phase 1 review snapshot

This branch is the first bounded delivery for issue #126, not the completion of
the issue. It establishes enforceable architecture constraints and moves a set
of behavior-preserving decisions behind typed seams. The dispatch-service
experiment was explicitly retracted when review found that it owned CLI and
OpenClaw presentation. PR4 through PR7 therefore remain open work, and this
phase must not close issue #126.

Measured against `main@ea592a8` on 2026-08-14:

| Metric | Baseline | Phase 1 | Delta |
| --- | ---: | ---: | ---: |
| Production physical LOC | 73,792 | 75,848 | +2,056 (+2.79%) |
| `src/cli-core.ts` physical LOC | 38,005 | 35,608 | -2,397 (-6.31%) |
| `cli-core.ts` production share | 51.5% | 46.95% | -4.55 pp |
| Production modules | 38 | 52 | +14 |
| Production import edges / cycles | 95 / 0 | 130 / 0 | +35 / 0 |
| Functions over 100 / 200 / 500 LOC | 167 / 57 / 9 | 164 / 58 / 9 | -3 / +1 / 0 |
| Approximate complexity over 20 | 150 | 143 | -7 |
| Test TypeScript physical LOC | 71,902 | 76,108 | +4,206 (+5.85%) |
| Test TypeScript files | 71 | 86 | +15 |

The result is a reduction in orchestration risk concentration, not a reduction
in total code size. The exact `cli-core.ts` and production totals are ratcheted
in `config/production-module-ownership.json`; later phases must reduce them
rather than conceal extraction overhead. The focused test loop remains about
ten seconds, while the real-process integration tier remains the dominant
delivery cost.

### Responsibility and dependency movement

| Seam | Responsibility moved inward | I/O, locks, and durable effects deliberately retained outside | Focused proof |
| --- | --- | --- | --- |
| Terminal binding authority | Exact binding-match decisions and typed list/mutation observations | Fresh terminal/process sampling and mutation revalidation remain in `cli-core.ts` | authority table tests plus list, lifecycle, handoff, and send integration |
| Verified-dead agent policy | Process-death proof validation, event replay, stall eligibility, completion tri-state | Process/transcript probes and terminal -> writer -> state orchestration remain in the shell | Codex/Claude completion-wins, fail-closed, deferred-transfer, and crash-replay tests |
| Canonical mutation kernel | Canonical acquisition/release plus fresh resource-bound terminal, writer, and optional state capabilities for four migrated paths | Business write ordering and raw filesystem/JSON adapters remain in composition | authenticity, lifetime, wrong-resource, cross-transaction, lock-order, error-precedence, and control-lock tests |
| Dispatch policy, zero-input abort reducer, and ledger codec | Pure preflight/abort precedence plus v1/v2 decode, construction, receipt merge, and validation | Ledger path selection, no-follow reads, atomic rename/fsync, Store locks, terminal input, and CLI formatting remain in the shell | reducer tables, codec byte/order tests, replay, receipt-fence, send-gate, and recovery tests; codec changes select the full tier |
| Lifecycle transition policy | Candidate/target classification and transition phase reduction | Terminal observation, transition CAS, deferred transfer, input, and recovery writes remain in the shell | transition tables and lifecycle/recovery integration |
| Callback policy, transport, and settlement | Retry decisions; Gateway process adapter; delivery progress/success/failure settlement | CLI composition owns the clock, state transaction, retry launcher, output, and callback preparation | retry matrix, exact transport call ordering, settlement write-order tests, and callback integration |
| Monitor seams | Approval clearing/suppression/notification, activity/completion/death/timeout decisions, fingerprint facts, and launch/ownership plans | Poll I/O, supervision process management, state/event writes, callback preparation, and terminal locks remain in the shell | decision/poll/launch tables and monitor recovery/lifecycle/approval integration |
| Terminal list renderer | Pure managed-Turn and action-contract projection from sampled facts | Store, process, ledger, Session, approval, and token observations remain in `cli-core.ts`; mutation never consumes list authority | exact v16 action order plus list/session/handoff integration |
| Conversation trace | Bounded executor-log parsing, secret redaction, and monitor-event projection | Status routing and conversation/event loading remain in `cli-core.ts`; the module performs only the existing optional read of the selected output log | exact parser/redaction/fallback unit tests plus management CLI integration |
| CLI runtime context | Per-execution dependency, output, clock, sleep, exit, and logging context | No business policy or persistent state moved into the runtime | nested and concurrent async-context isolation tests |
| Install and doctor adapters | OpenClaw plugin install/configure/restart/verify ordering plus typed doctor report composition | The shared CLI command runtime retains PATH/HOME lookup, package-root resolution, output redaction, and async-local exit/output authority; terminal, lifecycle, and dispatch logic are not imported | direct argv/effect-order, exact JSON bytes/key-order, exit-code, PATH/HOME isolation, and retained CLI boundary tests |

The new compile-time direction is
`cli-core composition -> callback settlement -> callback policy`, while the
OpenClaw child-process transport independently depends on the callback policy's
delivery outcome type. Settlement does not import the transport adapter or CLI
runtime.

### Lock and durable-write parity

No Store, Session, transition, dispatch-ledger, callback-outbox, or public
protocol version changes in Phase 1. The extraction keeps the existing lock
scope and durable ordering at each migrated call site. In particular:

- verified-dead reconciliation continues to acquire terminal dispatch lock,
  Store writer lease, then conversation state lock; callback execution stays
  outside those locks;
- callback settlement still executes progress as load -> save -> event,
  success as load -> save -> event, and failure as load -> retry-monitor launch
  -> save -> failure event -> monitor event;
- terminal dispatch still records prepared state/ledger/evidence before input,
  preserves `text_injected -> enter_dispatched -> agent_accepted`, and never
  retries an uncertain input;
- lifecycle transition and deferred-transfer CAS/write/crash boundaries remain
  in their original shell; and
- dispatch-ledger filesystem open/no-follow, temporary write, fsync, rename,
  directory fsync, and cleanup behavior was not moved into a generic repository.

The Phase 1 review gate is architecture validation, typecheck/build, focused
policy and adapter tests, and one exact-head full test run. Packaging,
publishing, installation, protocol upgrades, and issue closure are not part of
this phase.

### Reproducible refactor evidence guard

Run the local, non-integration evidence gate with:

```sh
npm run validate:refactor-evidence
```

`config/refactor-test-evidence.json` freezes two review inputs. First, it counts
static subprocess-startup call sites in `test/**/*.ts` for the immutable
`v0.12.11` baseline and the current tree. The included metric is CLI-process
plus fake-Node-process startup sites; other adapter/process calls are reported
separately. This is a deterministic source metric, not a claim about dynamic
process executions in one test run. The initial eight callback cases, the CLI
UX, native-ownership, management, selector, Session-binding, deterministic
dispatch-admission, and 20 normal callback invocations now use the imported
command service. The multilingual composer not-accepted witness now uses the
same imported command service while retaining the real tmux adapter and its
exactly-one-Enter assertion. Together these migrations reduce the current
value to 29 of 48 baseline sites (39.58%
reduction). The 60%
reduction target is still explicitly reported as not met. Its
`final_threshold.required` flag remains `false` while #126 is in progress; the
final milestone flips it to `true`, at which point an unmet target is a hard
validation failure.

Second, the manifest freezes the exact changed paths and subjects of ten
pre-`v0.12.11` product/test commits and replays them through the current
affected-test selector. The current selector falls back to the full tier for 9
of 10 changes (90%); the completion target is at most 2 of 10. The validator
fails if Git history, a frozen path list, the measured count, or a replay result
drifts without an explicit manifest review. An unmet completion target is
reported but does not make this Phase 1 evidence-recording command fail. This
target has the same `final_threshold.required` switch for the final milestone.

`config/public-contract-witnesses.json` is the machine-readable compatibility
inventory. It pins the package executable and facade, CLI commands/JSON
witnesses, list action contract v16, all 14 OpenClaw tools, Store format 1 and
writer protocols 1 through 5, and ten mappings from old executable tests to
focused service invariants and retained boundary witnesses. Every authority and
witness path must exist, each witness must remain in its declared test tier and
contain its named assertion, and unknown or missing manifest fields fail
closed.

`npm run validate:architecture` invokes the same evidence guard after the
ownership/import/LOC checks. Intentional contract or evidence changes therefore
require a reviewed manifest diff; changing only a number to conceal a failed
measurement does not pass because the validator reproduces it from source and
Git history.

## Callback/outbox application service

The callback milestone now has one typed application boundary for generic
callback preparation and execution, retry classification and monitoring,
startup reconciliation, terminal-completion outbox preparation, and approval
notification outbox preparation. The service composes the existing pure retry
policy, OpenClaw delivery contract, and settlement service; it does not import
`cli-core.ts`, filesystem or process adapters, CLI presentation, or raw locks.
The OpenClaw child-process transport implements the policy-owned delivery
contract rather than exporting an infrastructure type back into the service.

Measured against its exact pre-extraction head, this vertical moves 1,133
physical lines out of `cli-core.ts` while adding 387 physical production lines
overall. The reviewed overhead is the explicit typed port/result surface and
the direct service boundary; it is not hidden by unrelated cleanup or compact
formatting. The hard maxima are 396 physical lines and approximate complexity
32, below the 500/50 gates. The preparation span (277/32, including its nested
persistence phase), persistence phase (145/30), reconciliation callback
(129/20), and terminal-completion preparation (131/8) remain reviewed
exceptions to the default 100/20 target so their durable short-circuit and write
order stays visible. The production import graph remains acyclic.

The composition root still owns terminal and Store-writer locks, state-lock
implementation, Store/path resolution, JSON/event persistence adapters, retry
process launch, clock/process observation, Gateway transport construction, and
all public JSON. Terminal completion preserves state-lock scope across claim,
detected/message/outbox writes, and the record-only crash checkpoint, releases
that lock before settling the terminal dispatch ledger, and never replays
terminal input. Approval persistence still records the stable message id and
timestamp before invoking the service; the service either prepares that exact
message id or returns the same message without an outbox when no Gateway route
exists. Delivery settlement retains progress `load -> save -> event`, success
`load -> save -> event`, and failure `load -> retry-monitor -> save -> events`
ordering through the existing settlement service.

Direct fast proofs cover fresh/duplicate/non-retryable outbox preparation,
completion claim success/conflict and lock release, stable approval identity,
and the no-Gateway branch. Existing policy, settlement, transport, callback,
Claude, approval, monitor lifecycle, monitor recovery, and OpenClaw contract
witnesses remain the black-box boundary set.

## Terminal monitor decision policy

The monitor decision milestone moves one pure policy boundary out of the CLI
composition root. It owns completion-first poll reduction, approval prompt
clearing, question/error classification, every consumed-prompt suppression,
verified-dead completion classification, post-effect timeout classification,
activity cadence, and stable approval/activity/screen identity facts. It
directly composes the existing poll and verified-dead policies and performs no
I/O, locking, process access, callback delivery, or CLI presentation.

Measured against exact head `e62a79cc94428ddb9a5c264600f259ca4d05ee0c`,
the extraction reduces `src/cli-core.ts` from 32,398 to 32,146 physical lines
(-252) and changes total production TypeScript from 75,934 to 76,076 (+142).
The 42-line excess over the preferred +100 budget is the reviewed, explicit
typed decision surface and direct proofability; no formatting compression or
unrelated responsibility movement is used. The 394-line module remains below
the 500-line hard boundary, every new function remains below 100 physical
lines, and the hard approximate-complexity maximum is 27. The approval reducer
(67/27) and consumed-approval classifier (58/23) are transparent exceptions to
the default complexity-20 target: their branch tables stay cohesive and direct
tests lock every precedence path.

The composition root still owns terminal singleton, Store-writer and state
locks; terminal observation and input adapters; process launch and death
probing; state/event/outbox writes; callback continuation; clocks and sleeping;
and public JSON/log presentation. Approval effects retain their asymmetric
durable order: question follows `fingerprint -> event -> record`, while an
unapprovable or evidence error follows `event -> fingerprint -> record`.
Polling retains `activity -> completion -> verified-dead -> fresh clock ->
timeout`, so work performed by persistence or the death probe can cross a
deadline without deferring the timeout by one poll. Application orchestration
and those effect ports remain the follow-on monitor service milestone.

## Terminal monitor application service

The monitor application milestone moves the singleton-owned retry loop and the
complete locked monitor state machine behind five typed port groups: state,
authority, callbacks, runtime, and presentation. The service owns initialization,
submission reconciliation, binding deferral, observation application, approval
continuation, activity persistence, stable completion, verified-dead fallback,
and timeout routing. It composes the canonical monitor decision and poll policies;
it does not import `cli-core.ts`, filesystem or process modules, raw lock or JSON
persistence implementations, a callback transport, or a public JSON presenter.

Measured against exact head
`b637c012cfa87315380c150405a3384d653ac847`, the extraction reduces
`src/cli-core.ts` from 28,336 to 27,319 physical lines (-1,017). Total
production TypeScript changes from 79,308 to 80,554 lines (+1,246, 122.52
percent of the core reduction). The transparent overhead is the 1,583-line
typed application boundary, the 680-line CLI adapter and presenter boundary,
and their direct trace types; no unrelated deletion or compressed formatting is
used to hide that cost. Every new function remains within the preferred
100-line/complexity-20 target. The largest is the 98-line/c20 public-result
presenter; the largest service function is the 89-line/c11 approval application,
and the service complexity maximum is c13. The production import graph remains
acyclic.

`cli-core.ts` still resolves the exact state and event paths, acquires the
singleton owner, and supplies the concrete terminal, Store-writer and Turn-state
lock functions. It also supplies state/event/ledger repositories, live process
and death probes, terminal observation, callback transport construction, clock
and crash hooks, and the public JSON/log writer. The CLI adapter accepts only
those invocation-local capabilities, applies them in the legacy lock order, and
cannot manufacture a path, Store, terminal route, or lock.

The application order remains `initialize -> submission reconciliation -> poll
-> detector/approval -> activity -> stable completion -> independent verified
death -> fresh clock -> timeout`. A completion persisted immediately before
process exit therefore still wins over orphan cleanup, and work performed by a
death probe can cross a deadline without postponing timeout classification by
one poll. Approval effects keep their intentional asymmetry: question is
`fingerprint -> event -> record`, while an unapprovable/evidence error is
`event -> fingerprint -> record`. Stale notifications sleep and retry without
callback execution; duplicates present without delivery; a consumed question
callback resumes the same generation; callback and completion claims remain
outside the Turn-state lock exactly as before.

Direct fast traces prove live-dispatcher PID gating before terminal I/O, two-poll
completion stability, exactly one status/screen snapshot per poll with the legacy
completion-metadata read order, death-before-fresh-clock ordering, both approval
effect orders, executor-to-callback actor mapping, prepared-recovery release
order (`state -> writer -> terminal`), and zero terminal I/O on a fresh-state
retry. Acceptance errors and not-accepted/fenced presentations remain inside
the terminal send lock; pending acceptance releases that lock before backoff.
The retained lifecycle, approval and
recovery shards provide 21 executable boundary cases for singleton ownership,
Store-lock deferral, callback concurrency, detector diagnostics, durable
completion, verified death, timeout, duplicate settlement, handoff and monitor
relaunch behavior.

## Native-thread lifecycle query slice

The first native-thread lifecycle application slice moves only read-side
candidate discovery, active-owner observation, exact candidate-token
revalidation, restorable-origin eligibility, and previous-thread projection
behind `NativeThreadLifecycleQueryPorts`. New-thread and resume-thread mutation,
handoff, verified-empty recovery, reconciliation, dispatch recovery, selection
snapshot persistence, and public JSON presentation remain in `cli-core.ts`.
The query service has no transaction, lock, capability, Store-save, snapshot-save,
terminal-input, recovery, or presenter port.

Measured against exact head `ceb1e2fbb9ffa65af139182b36ea0bd527f4fe1e`,
the slice reduces `src/cli-core.ts` from 31,321 to 30,775 physical lines (-546)
and changes total production TypeScript from 76,474 to 76,569 (+95). The query
service is 495 physical lines. No function reaches 500 lines; architecture
validation retains the hard approximate-complexity ceiling of 50. The
production import graph remains acyclic and the module has one targeted
ownership domain, `native-thread-lifecycle-query`, with five retained lifecycle
integration witnesses.

The default approximate-complexity target remains 20. The reviewed cohesive
exceptions are `activeNativeThreadOwners` (93 LOC/c28),
`verifiedPreviousResumeCandidate` (68 LOC/c24), and
`decodeThreadCandidateToken` (38 LOC/c21); all remain below 100 LOC and c50.

The composition root implements the read port with frozen method-only adapters.
It continues to own filesystem/process observation, terminal and agent adapters,
Store path selection, selection snapshot writes, clock sampling, and public JSON.
Store path selection is lazy and memoized at the first Store observation; token
revalidation that fails before a Store read cannot resolve or inspect that path.
Candidate observation preserves `active process ownership -> managed Session
observation -> exact running version -> provider discovery`. Invalid UUID and
Store-authority errors precede terminal scanning; an active external owner
precedes managed-Session conflict observation. Version failure never calls the
candidate provider. Candidate tokens retain baseline `JSON.stringify` byte and
key-order semantics; no canonicalization was introduced. Their codec, candidate
sorting, committed-previous policy, and pure snapshot assertions live in the
adapter-neutral `native-thread-resume-snapshot-policy.ts`, so importing the
query service cannot load snapshot filesystem persistence.

The direct fast table locks version short-circuit, observation order,
deduplication and sorting, exact token mismatch precedence and bytes, Store then
terminal ownership error priority, and one exact committed-transition read for
the previous resume candidate. Snapshot assertion traces additionally lock lazy
cwd and clock callbacks, terminal-evidence order, fingerprint-before-row
short-circuiting, ordered-row equality, and rollout `JSON.stringify` field-order
sensitivity. Since this slice writes nothing, it adds no durable-write or crash
window; the existing core snapshot write and lifecycle mutation/recovery
witnesses remain authoritative until the separate mutation application slice.

## Terminal monitor startup eligibility policy

Startup, handoff, and locked launch preparation now share one pure staged
eligibility policy. The policy owns candidate priority and exact reason text for
terminal-bridge identity, dispatch authority, blocking submission, runtime
identity, deferred-transfer acceptance, and deadline metadata. Its generator
yields only the next typed observation, so the CLI composition root does not
touch terminal control, the dispatch ledger, Store path authority, runtime
identity, or a deferred transfer until every earlier candidate has passed.
The policy has no ports, filesystem or process access, locks, mutation, or CLI
presentation.

Measured against exact head `8e5c636604845d42f4f0e0af28b36621974e75b6`,
the extraction reduces `src/cli-core.ts` from 30,775 to 30,640 physical lines
(-135) and changes total production TypeScript from 76,569 to 76,649 (+80).
The new policy is 195 physical lines. Its 135-line staged reducer has approximate
complexity 48: this is a reviewed transparent exception to the preferred 100/20 target,
while remaining below the hard 500/50 gate. Keeping the precedence in one
reducer makes every short circuit directly table-testable without concealing
branches in I/O adapters. The shared, I/O-free `terminal-submission-facts.ts`
owns the submission projection and typed Codex anchor codec; its 99-line
validator has approximate complexity 49, a reviewed transparent exception to
the preferred complexity-20 target and still below the hard gate. All other
new functions are below 15 lines and complexity 5.

The composition root remains the sole owner of terminal-control decoding,
dispatch-ledger and deferred-transfer reads, Store path derivation and symlink
validation, runtime identity observation, locks, mutation, monitor launch, and
public JSON/log presentation. Observation order remains `bridge/status ->
message -> terminal control -> dispatch ledger -> conversation state path ->
Store derivation -> submission -> runtime -> Store derivation -> deferred
transfer -> deadline`. In particular, non-terminal and inactive candidates
never derive a Store, while a malformed Store path still fails before an
already-invalid dispatch ledger is classified, preserving the prior error
precedence. Dispatch `state_path` is not observed until the earlier ledger,
message, control, conversation, Session, and Turn predicates have passed.

## Native-thread transition verification and settlement

The second native-thread lifecycle slice moves the mutation's typed
verification and settlement seam out of the CLI composition root. Before any
durable transition is prepared, the verification adapter preserves lifecycle
eligibility, plan selection, initial idle status, the exact Claude agents-row
proof, and the single Codex `/status` probe. After core has durably recorded
`command_submitted`, the settlement service owns stable identity verification,
verified-transition persistence, the verified crash checkpoint, exclusive
target ownership, Session commit, committed-transition persistence, resolved
ledger persistence, and final presentation. Dispatch preparation, composer
revalidation, terminal input, raw lock acquisition, recovery, handoff, and
verified-empty reconciliation remain in `cli-core.ts`.

Measured against exact head `a96bfbb2c6d011e4bdbe53f883e01250ad1e4023`,
the slice reduces `src/cli-core.ts` from 29,281 to 28,610 physical lines
(-671) and changes total production TypeScript from 77,792 to 78,388 (+596).
The transparent typed-capability overhead is 88.8% of the core movement. Issue
#126 has no production-zero-growth requirement; the added lines are the five
explicit port groups, exact verification adapter, capability-scoped repository
surface, post-lock terminal/Store resource adapter, and reusable direct evidence
rather than formatting compression or an unrelated responsibility move.

`runNativeThreadTransition` is 421 LOC/c1, with its transaction callback at
412 LOC/c44. The settlement service is 331 physical lines; its largest function
is `settleFailedNativeThreadTransition` at 124 LOC/c9. The verification adapter
is 707 physical lines; its largest function is
`verifyNativeThreadTransition` at 201 LOC/c45. Every function remains below the
hard 500 LOC/c50 gates. Reviewed exceptions to the default 100 LOC/c20 target
are the cohesive transaction wrapper/callback (421/c1 and 412/c44), core port
wiring (173/c1), failure settlement (124/c9), verification polling state
machine (201/c45), and shared known-root reducer (94/c24). Keeping these order
tables intact makes their fail-closed precedence visible and directly testable.
The 100-line resource adapter's exported operation is 77 LOC/c1 and its inner
capability gate is 55 LOC/c14, so it requires no default-threshold exception.

The service imports no filesystem or path API, raw lock, Store directory,
public JSON, terminal bridge, `any`, or `Record<string, any>`. Core still owns
argv and public JSON, constructs concrete terminal and Store adapters, acquires
terminal then writer locks, and invokes the presenter before leaving the
transaction callback. Every service repository operation receives the same
authentic `CanonicalMutationScopes` and `CanonicalMutationResources`; the
capability-gated repositories bind every verification, ownership, transition,
Session, and ledger operation to both locked resources. Before observation or
I/O, the adapter verifies active scopes, the post-lock terminal's exact resource
key and process incarnation, and the captured Store resolving to the active
canonical writer. Lifecycle ledger
construction and save form one scoped port; its `store_dir` must strictly equal
the active writer Store, and persistence uses the post-lock fresh terminal route.
The lifecycle resource adapter reuses the common mutation pair gate and
`terminalRuntimeResourceKey`; it imports no terminal-dispatch domain module.
Agent kind and PID come only from that resolved terminal and are absent from the
service verification request.
Lifecycle and dispatch compatibility exports share one adapter-neutral native
identity fence, matcher, and strict complete-rollout predicate in
`terminal-binding-authority.ts`. Blank or malformed runtime rollout fields fail
closed before path comparison and cannot escape as a `TypeError`.

Verified success retains `verify -> verified transition -> crash hook ->
ownership -> Session commit -> committed transition -> resolved ledger ->
present`. Failure retains committed-bookkeeping error precedence, verified
recovery without roll-forward, proven-zero-input abort plus source restoration,
and possible-input uncertainty plus source quarantine. A five-case recording
port table asserts those orders, exact scope/resource forwarding, and
presentation before writer and terminal lock release. The no-rollout identity
case separately proves that a legitimate status-card or pre-materialization
observation returns false without reading a missing rollout or throwing. One
targeted ownership domain retains five native lifecycle integration witnesses.
Direct resource-adapter cases additionally prove moved-route fresh bytes and
zero verification/ownership/ledger I/O for wrong incarnation, malformed or
key-mismatched terminal/writer resources, captured-Store mismatch, and released
scopes. Adapter cases pin Codex probe/companion ordering, Claude rows-before-status
ordering, and the no-revalidation callback's original synchronous invocation.

## Terminal list and action authority projection

The terminal-list milestone gives list projection and fresh mutation
preparation one canonical send-authority reducer. `terminal-action-projection.ts`
owns Session-claim conflict precedence, dispatch/Session conflict composition,
send authority, safe action selection, management facts, and handoff/recovery
projection. `terminal-authority-policy.ts` owns provider-neutral terminal and
process-incarnation facts, managed-binding conflict classification, Codex
companion fences, exact deferred-source authority, stored Turn identity, and
the byte-sensitive verified-empty, deferred-foreground, observed-handoff, and
active-Turn token codecs. Both modules are typed and have no filesystem,
process, lock, CLI-option, concrete-adapter, or public-JSON input boundary.
The adapter-neutral complete-rollout predicate, identity fence and matcher from
the lifecycle slice remain canonical in `terminal-binding-authority.ts`;
authority policy directly imports and re-exports them. That module also owns
the single status-card predicate and neutral binding-conflict/candidate helpers.
PR4C's dispatch execution service imports those identity decisions from binding
authority and its process-incarnation and companion decisions from authority
policy, so production has one implementation for each decision and no cycle.

Measured against exact lifecycle head
`10b2b9c60a8f5635961156bf9951472ea5542a48`, this slice reduces
`src/cli-core.ts` from 28,610 to 28,336 physical lines (-274) and changes total
production TypeScript from 78,388 to 79,308 (+920).
The overhead is reported rather than hidden by compact formatting: it is the
explicit typed observation handoff needed to keep Store and terminal reads in
the composition root while making each authority stage independently bounded
and testable. The production graph has 78 modules, 307 static import edges, and
zero cycles. Targeted ownership is split honestly across
`terminal-action-projection` and `terminal-authority-policy` with five retained
integration witnesses each; the pre-existing binding-authority and
dispatch-policy owners are also reduced to five witnesses each.

The old 1,162-line terminal projection callback is now a sequence of bounded
stages. The final TypeScript AST spans are binding observation 298 lines,
verified-empty authority 97, deferred-source authority 77, deferred action
authority 106, handoff authority 139, terminal-scoped approval authority 96,
authority composition 23, public rendering 256, and the outer list projection
144.
No touched or extracted function reaches the hard 500-line boundary. The
TypeScript AST approximate-complexity maximum across the touched and extracted
production functions is 48, below the hard approximate-complexity-50 gate.
Binding observation, deferred action authority, handoff authority, and
public rendering are reviewed exceptions to the preferred 100-line and/or
complexity-20 targets: further splitting them would duplicate the staged facts
or move Store reads across a safety short circuit.

The composition root continues to own deferred-transfer, managed-Session,
managed-Turn, transition, and dispatch-ledger reads; terminal/process
collection; Codex inventory and identity observation; terminal-scoped approval
boundary I/O; runtime logging; and the final public JSON shell. The staged calls
preserve the old left-to-right read order. In particular, a Session-authority
conflict never reads the dispatch owner's Session id, a genuine mismatch keeps
the old two `sessionIdForConversation` calls, and every unresolved-transition
read remains behind the same verified-empty, reconcile, external-handoff, or
active-Turn preconditions. Listed tokens remain stale snapshots; mutation paths
repeat fresh observation and invoke the same canonical send reducer before a
side effect. Blocking Turn statuses do not inspect callback delivery, current
approval actions are retargeted before reading the live terminal approval
state, and stored native rollout fields remain unread until all earlier Turn
identity exits have passed.

Direct fast proofs compare the old and new `JSON.stringify` action bytes and
key order, verified-empty and deferred v2/v5 token hashes, active-Turn handoff
hashes, conflict precedence with lazy managed-Turn facts, selector alias and
process-incarnation behavior, and list-snapshot versus fresh-mutation send
decisions. Getter-backed fixtures make the three lazy-read fences executable,
and ordinary fixtures compare canonical results with the previous decisions.
Existing binding-authority, dispatch-policy, list-renderer, and
terminal-send boundary witnesses remain in place; this slice changes no action
name, action order, error string, token field order, Store format, or public
contract version.

## Soft freeze while #126 is active

Until the orchestration milestones finish:

1. Do not add product features directly to a hotspot in `cli-core.ts`. Route new
   work through the next typed seam when reasonably possible.
2. Security, data-loss, liveness, and release-blocking regressions may patch the
   current path, but the PR must identify the temporary ownership and update the
   extraction inventory.
3. Do not introduce new `Record<string, any>` service inputs, new `*LockHeld`
   booleans, new direct persistence calls in `cli-core.ts`, or a new lock-order
   exception.
4. Keep refactor PRs free of unrelated user-facing behavior changes. A behavior
   change needs its own issue, acceptance tests, and explicit review.
5. Retain real-process contract tests for argv/exit, terminal input, Store crash
   recovery, and OpenClaw callback boundaries. First add deterministic reducer
   tests; consolidate duplicate black-box cases only after equivalent contract
   coverage is demonstrated.
6. Do not weaken identity, token, composer, approval, ownership, CAS, uncertain
   outcome, or callback isolation fences to make extraction easier.

## Measurement method

Physical LOC is `wc -l` over checked-in `src/*.ts`. Function and approximate
complexity measurements use the TypeScript compiler AST and count functions,
methods, accessors, constructors, function expressions, and arrow functions with
bodies. Approximate complexity is `1 + if/loop/case/catch/?:/&&/||/??`, excluding
nested function bodies from the enclosing function. It is a prioritization
signal, not a semantic correctness score.

The JSON baseline is immutable for this snapshot. Future PRs append their own
before/after measurements or replace the documented current baseline while
retaining this commit as the historical comparison point.

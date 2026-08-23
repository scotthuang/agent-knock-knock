# Orchestration refactor architecture baseline

Status: architecture implementation and enforceable static gates are complete
at the current closeout;
[issue #126](https://github.com/scotthuang/agent-knock-knock/issues/126)
remains open for longitudinal acceptance. The final timed
fast/integration/full profile, dynamic subprocess runtime attestation, and one
local OpenClaw install are separate pending final-evidence steps; this status
does not claim they have run.

The four remaining criteria require observations after the refactor:

- at least 70% of normal product changes no longer modify `cli-core.ts`;
- at least 80% of normal affected-test loops complete in 60 seconds or less;
- five post-refactor product changes reduce median ready-to-release lead time
  by at least 40%; and
- repeated full-suite flaky failures remain below 1%.

The frozen ten-change selector replay proves selector behavior, and a
point-in-time suite profile proves only that measured revision. Neither can
substitute for these four longitudinal samples.

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

1. Resolve one trusted, versioned, secretless callback route; a present invalid
   route fails closed and never falls back to legacy host fields.
2. Prepare one immutable callback envelope and deterministic delivery/idempotency
   identity.
3. Persist the envelope, route snapshot, pending outbox state, and attempt lease
   before transport.
4. Resolve the route to a concrete adapter at the composition root. The current
   adapter preserves the OpenClaw Gateway behavior; core services do not select
   or construct it.
5. Persist an explicit accepted, retryable-failure, permanent-failure, or
   uncertain attempt outcome. Only retryable failure schedules another attempt;
   accepted checkpoints survive a later wake/observation failure.
6. Reconciliation resumes only the same persisted route, envelope,
   message, and attempt authority. Current CLI options or Conversation fields
   cannot redirect an existing outbox.

Callback transport state does not own or rewrite the semantic Turn phase.
Cross-Session callback delivery remains strictly isolated.

The first host-neutral slice retains the existing OpenClaw fields and Turn
status names as a read/write compatibility projection. OpenClaw's trusted
plugin still supplies the controller session identity; model-facing tools never
accept a callback destination or profile. A standalone supervisor and new host
adapters remain separate follow-on work.

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
and authority composition remain in `cli-core.ts`. At the PR4C slice, the
82-line `terminal-dispatch-composition.ts` file was explicitly recorded as a
temporary CLI-infrastructure type bridge owned by `terminal-dispatch-core`,
not an application service: it still named a concrete resolved terminal type
and the legacy `Record<string, any>` options bag, with PR7 assigned to remove
that leakage while moving the remaining facade.

The final PR7 decision keeps `TerminalDispatchTerminal` as a structural
CLI-infrastructure carrier only and eliminates the untyped options bag through
the six-field, unknown-valued `TerminalControlSendOptions` boundary. Business
services still receive explicit terminal fact projections, authenticated
routes, repositories, and typed ports; neither the structural carrier nor the
CLI options object crosses an execution, application, capability, or deferred
foreground service boundary.

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
moved boundary. Every production function must stay strictly below 500
physical lines and approximate complexity 50; reaching either boundary fails
the zero-allowlist hard gate. The normal target is under 100 lines and
complexity under 20.

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
exactly-one-Enter assertion. The final slice also imports redundant callback,
installer, verifier/guard, Claude recovery, and nested approval wrappers. The
product-test value is now 19 of 48 baseline sites, a 60.42% reduction, and its
`final_threshold.required` flag is `true`. Measurement self-tests are reported
separately (baseline zero; current ten included fake-Node probes) under one
fixed diagnostic path applied to both revisions; they cannot dilute the
product migration ratio.

Second, the manifest freezes the exact changed paths and subjects of ten
pre-`v0.12.11` product/test commits and replays them through the current
affected-test selector. Eight changes now select owned integration witnesses;
the two commits that changed exact `src/store.ts` authority remain full. The
measured fallback is therefore 2 of 10 (20%), meeting the completion target.
Every normal production domain is capped at five integration witnesses, while
unknown paths, `src/store.ts`, `src/protocol.ts`, and shared kernels remain
full. Known test helpers resolve through an explicit transitive consumer map.
Tier-manifest additions and synchronized package-version bumps narrow only from
Git parent/current blob proof; deletion, movement, reordering, dependency
changes, or an unproved caller object fail closed. The validator fails if Git
history, a frozen path list, the measured count, or a replay result drifts, and
`affected_selector_replay.final_threshold.required` is now `true`.

`config/public-contract-witnesses.json` is the machine-readable compatibility
inventory. It pins the package executable and facade, CLI commands/JSON
witnesses, list action contract v16, all 14 OpenClaw tools, Store format 1 and
writer protocols 1 through 5, and eleven mappings from old executable tests to
focused service invariants and retained boundary witnesses. Every authority and
witness path must exist, each witness must remain in its declared test tier and
contain its named assertion, and unknown or missing manifest fields fail
closed.

`npm run validate:architecture` invokes the same evidence guard after the
ownership/import/LOC checks. Intentional contract or evidence changes therefore
require a reviewed manifest diff; changing only a number to conceal a failed
measurement does not pass because the validator reproduces it from source and
Git history.

### Codex no-rollout process-contract consolidation

The canonical integration witness
`test/codex-no-rollout-binding-cli.test.ts` still declares the same 97 named
tests with their original assertions. `config/test-file-shards.json` assigns
every declaration to exactly one of eight worker entrypoints. Test-tier
selection, production ownership, affected-test selection, public-contract
evidence, and dynamic subprocess evidence continue to name the canonical path;
the tier runner expands that one path to every compiled shard and fails closed
for a missing, duplicate, unused, out-of-range, or uncompiled shard. A targeted
canonical selection also rejects a shard query that does not match its actual
worker entry, so it can never execute only a subset while claiming the whole
witness.

Repeated executable invocations now use the same imported parser/command
boundary and fixture-scoped virtual clock as the surrounding invariant tests.
For injected exit checkpoints, the fixture freezes the exact durable filesystem
image at `cliExit`, rewrites active lock ownership to the simulated dead CLI
PID, and restores files without changing surviving rollout inodes before the
next recovery command. Ordinary exception compensation after the injected exit
therefore cannot forge the crash state, while recovery still proves lock
reclamation, descriptor identity, exact CAS state, and zero replay.

| Former repeated executable role | Same retained invariant | Authoritative real-process witness |
| --- | --- | --- |
| Virgin attach, terminal send, and status variants | Exact parser/command routing, terminal text plus one Enter, acceptance binding, and no Store mutation | `doctor exits non-zero when required package files are missing` in `cli-ux.test.ts` retains argv/exit; `raw background send durably prepares its terminal submission before tmux accepts it` in the composer-replay shard retains real terminal-adapter input |
| Deferred preparation, commit, acceptance-backfill, and recovery crash variants | Exact durable image at every named `cliExit(86)` checkpoint; subsequent recovery retains Session/Turn/ledger/transfer state and never replays input | `zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry` retains the real Store crash and exit-86 boundary used by dynamic evidence |
| Startup candidate-monitor reconciliation | Exact pending Turn is accepted and completed once, its transfer and dispatch ledger resolve, and no callback state appears | `startup reconciliation relaunches one pending candidate monitor without replay` retains detached monitor PID launch, liveness, and process exit |

The no-rollout suite retains two explicit `runCliSubprocess` call sites for its
unique Store-crash and detached-monitor process boundaries. Consolidation does not
shorten a production timeout, raise test concurrency, remove a test or
assertion, or replace the separate OpenClaw callback process boundaries.

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
## Native-thread lifecycle crash recovery and reconciliation

The third native-thread lifecycle slice moves one crash-recovery state machine
from `recoverLifecycleFenceBeforeMutation` through fail-closed lifecycle-ledger
reconciliation into `native-thread-lifecycle-recovery-service.ts`. It includes
human-observed ledger rebuild, prepared rollback, verified roll-forward,
committed/aborted replay, possible-input quarantine, and operator-authorized
Claude/Codex identity reconciliation. Ordinary deferred foreground-dispatch
recovery remains a core-owned state machine behind one scoped call. Verified
empty recovery, observed external-handoff send/adoption, lifecycle mutation,
monitor/callback orchestration, and public presentation remain outside this
service.

Measured against exact head `29446b0649555c4bfca8ee23a4f2f0d9523c9fcf`,
the slice reduces `src/cli-core.ts` from 27,319 to 26,095 physical lines
(-1,224, -4.48%) and changes total production TypeScript from 80,554 to
81,427 (+873, +1.08%). The transparent typed-boundary overhead is 71.3% of
the core movement. It consists of the four port groups, direct recording
surface, fresh-route composition, normalized probe facts, and the core-side
raw terminal adapter; issue #126 does not impose a zero-production-growth
target. The production graph has 82 modules, 339 static import edges, and zero
cycles.

The recovery service is 1,834 physical lines and its infrastructure adapter is
263 lines. The largest function remains the 211-line/c32 reconciliation reducer
and the highest conservative approximate complexity is c37 in the 186-line
manual Codex probe reducer. Every function is below the hard 500 LOC/c50 gates.
The reviewed exceptions to the default 100 LOC/c20 target are:

- reconciliation (211/c32), whose ordered status and catch precedence is one
  directly recorded state machine;
- prepared human-observed handoff recovery (116/c21), which keeps its source
  CAS, identity observation, rollback, and verified checkpoint together;
- stored ledger/transition comparison (66/c36) and live-terminal/adapter
  comparison (68/c25), split only at the side-effect boundary so boolean
  short-circuit order is unchanged;
- verified after-binding revalidation (143/c36), uncertain manual settlement
  (140/c15), Claude stable identity probing (115/c27), and Codex stable identity
  probing (186/c37), whose polling and exact-incarnation precedence remain
  visible as cohesive reducers;
- the core-side probe adapter factory (110/c1), which keeps its closed raw
  capability, bridge preparation, normalization, and ordered observations in
  one infrastructure boundary while each returned method remains short.

The service imports no CLI core, filesystem/path API, raw lock, raw repository,
raw JSON persistence, public presenter, `TerminalAgentAdapter`, terminal-agent
bridge type or value, `any`, or `Record<..., any>`. It contains no raw screen
excerpt or composer grammar. Its public request contains only fresh terminal
facts; Store directory and path authority are absent. The four typed port
groups are scoped authority, persistence, terminal/process evidence, and
clock/sleep. Core retains terminal then writer lock acquisition, the ordinary
deferred-recovery implementation, raw transition/Session/ledger repositories,
terminal bridge and process probes, Store/path canonicalization, CLI logging,
and JSON output. The core-side recovery adapter exposes only normalized
status/probe facts and closed plan steps through separately scoped
`probeThreadLifecycle`, `planThreadLifecycle`, and `observeThreadLifecycle`
ports; the full terminal adapter is never returned to business code. Before
either service entry, core projects the fresh resolved terminal into a new
runtime object with exactly `conversationId`, `agent`, `pid`, and
`terminalControl`; the broad resolved terminal remains captured only by the
core ports closure.

Every authority, repository, process, and terminal port call receives the same
active `CanonicalMutationScopes` and `CanonicalMutationResources`. Before the
service is entered, core authenticates both scopes, resolves the terminal again
after lock acquisition, proves the captured and fresh terminal/process
incarnations match, and captures the canonical writer Store. The shared native
thread resource adapter repeats those checks for every port call, including
reads and probes as well as transition, Session, and ledger writes. Thus a
request cannot retain free terminal-control, Store, cwd, or path authority, and
released, cross-transaction, wrong-route, or wrong-Store capabilities fail
before business I/O. Lifecycle ledger construction remains in the core adapter;
rebuild phases replace their control with the post-lock fresh route and every
persisted ledger Store must equal the canonical writer resource.

### Recovery order and durable checkpoints

The extraction preserves these existing sequences inside the terminal ->
writer lock scope:

| Recovery path | Exact effect order retained |
| --- | --- |
| Fence entry | authenticate/fresh terminal -> ordinary deferred recovery -> ledger load -> optional rebuild -> lifecycle classification -> reconcile |
| Missing/resolved human-handoff ledger | transition list -> typed ledger build -> complete transition/terminal/adapter validation -> compare-and-save rebuild ledger -> reload |
| Live automatic dispatcher | dispatcher process probe -> unchanged ledger; no Store transition read, probe bridge, or write |
| Wrong Store / unavailable transition | Store comparison or transition load -> fail-closed uncertain-ledger CAS -> reload; a failed fail-closed CAS returns the original ledger |
| Prepared, zero possible input | ledger/terminal/adapter validation -> exact before-owner proof -> target/source reads and source restoration -> aborted transition CAS -> resolved-ledger CAS -> reload |
| Verified | after-binding/live identity verification -> exact target-owner proof -> Session commit -> committed transition CAS -> resolved-with-binding ledger CAS -> reload |
| Committed / aborted replay | live verification and owner/target assertion or before-owner/source restoration -> resolved-ledger CAS -> reload |
| Dispatching/submitted automatic recovery | uncertain transition CAS -> source quarantine Session CAS -> uncertain-ledger CAS -> reload |
| Operator-authorized uncertain recovery | exact stable manual probe -> process/rollout assertion -> before rollback, or target verification -> target-owner proof -> Session commit -> committed transition CAS -> resolved-ledger CAS -> reload |
| Inner recovery failure | source quarantine attempt -> fail-closed uncertain-ledger CAS -> reload/original ledger |

Bridge construction remains at the old probe checkpoints: after the verified
human-handoff early return, after Claude prepare-time process validation, and
after the Codex-agent guard but before root/runtime observation. Raw terminal
status, clear-line, `/status` input, agents rows, resolver, and process-birth
operations stay in core or its recovery adapter. A Claude sample performs
agents-row load then lifecycle observation inside one scoped call, and business
recovery performs terminal status only afterward. A Codex post-`/status` sample
performs one raw status call and only then raw-screen lifecycle observation
inside the same scoped adapter call; it returns normalized status plus the
optional observation. No raw screen or composer decision crosses into the
service. No new durable checkpoint or retry permission is introduced. Manual
terminal-close JSON is still emitted by core before the writer and terminal
scopes are released.

The direct fast recording table fixes five precedence witnesses: live
dispatcher short-circuit; wrong-Store fail closed before transition load;
prepared rollback; dispatching possible-input quarantine; and verified
roll-forward. It asserts the exact transition/Session/ledger phase order, CAS
expectations, probe-before-plan order, probe preparation point, and
reference-equal forwarding of the same active scopes/resources on every port
call. Direct adapter witnesses fix Claude rows -> observe and Codex status ->
observe order, while the static boundary witness rejects bridge imports, full
terminal-adapter capability, raw screen excerpts, or composer helpers in the
service. A runtime-shape witness also fixes the four projected request keys and
proves that neither `adapter` nor `legacy` survives projection. Existing
lifecycle recovery, human handoff, no-rollout, lifecycle, and ownership
integration witnesses remain the retained black-box boundary set.

## Deferred Codex foreground application and recovery

This slice moves the complete deferred Codex foreground application vertical
out of `cli-core.ts`: preparation and fresh-authority publication; source
reservation and target preparation; dispatch begin/stage advancement;
zero-input abort and rollback; accepted commit and resolution; uncertain
settlement; and prepared, accepted, and committed crash recovery. The typed
implementation is split across the application, preparation, and recovery
services plus their CLI adapters, a data-only boundary module, and the
invocation-scoped repository capability. Observed handoff, native-thread
lifecycle recovery, ordinary dispatch, monitor/callback behavior, public
presentation, and raw terminal I/O remain outside this vertical.

Measured against exact head
`257950022ea40e343808ef68c903c6f874497a09`, the slice reduces
`src/cli-core.ts` from 26,095 to 23,124 physical lines (-2,971, -11.39%) and
changes total production TypeScript from 81,427 to 84,241 (+2,814, +3.46%).
Typed production overhead is 94.7% of core movement, leaving 157 lines of
positive movement margin. The production graph has 90 modules, 417 static
import edges, and zero cycles.

Across the eight new production modules, the TypeScript AST inventory contains
219 functions. No function reaches the default 100 LOC/c20 review threshold;
the maxima are 92 LOC and c19. Consequently there is no 500 LOC/c50 hard-gate
exception. Application and preparation each expose three typed port groups;
recovery exposes four. No service imports CLI core, Node filesystem/process
APIs, raw JSON/lock helpers, a presenter, `ResolvedTerminalConversation`,
`TerminalAgentAdapter`, or the concrete capability adapter. The service-side
repository scope is a narrow interface in `deferred-foreground-boundary.ts`;
its implementation is module-private and can only be obtained through the
production terminal/writer or terminal/writer/state binders.

The preparation request receives a projected terminal object with exactly
`conversationId`, `agent`, `pid`, optional `workspace`, `target`, `resourceKey`,
optional endpoint evidence, and `canonicalEndpoint`. The returned application
boundary contains only those terminal facts and immutable transfer/session,
process-incarnation, dispatch-snapshot, rollout-authority, and CAS facts. The
resolved terminal, concrete control, adapter, legacy marker, Store directory,
Turn paths, and terminal transport methods remain captured in CLI adapter
closures. Runtime `Object.keys` witnesses fix the request, terminal-facts, and
boundary shapes and reject `adapter` or `terminalControl` leakage. A stable
data-only projection carries the source-reserved and target-prepared revisions
and binding tokens through verification, dispatch, commit, and resolution;
the associated broad terminal remains only in the CLI adapter.

The capability binder authenticates one active terminal -> Store writer ->
optional Turn state transaction before repository use. Terminal incarnation
and resource key, absolute canonical Store key/value, `state.json` membership
under that Store, matching `events.ndjson`, and state resource key/value are
checked before I/O. Null, object, relative, cross-Store, wrong-key,
wrong-process, wrong-log, and released-scope cases fail with ordinary errors
before repository access. The concrete scope is not exported, and every scope
method repeats the active-scope gate; retained scopes therefore expire when the
transaction callback returns. Recovery asserts the transfer, projected
terminal, and Turn route immediately after candidate selection and carries the
same scope through every transfer/Session/state/ledger adapter operation. The
PR172 lifecycle-recovery service retains ownership of its state machine and
invokes this deferred service through its existing `recoverDeferred` port with
the same active terminal and writer scopes/resources.

### Application, CAS, and recovery order

The extraction preserves these Store, Turn, ledger, and terminal-evidence
orders:

| Path | Exact effect and CAS order retained |
| --- | --- |
| Fresh preparation | process incarnation -> fresh rollout/dispatch observation -> fresh binding token -> target/transfer IDs -> canonical boundary revalidation -> exclusive ownership -> unresolved-transfer list (source identity or terminal id + endpoint; PID is not collision authority) -> request hash -> dispatcher pid -> clock -> transfer create with expected revision `null` |
| Stale list token | process incarnation -> fresh observation -> freshly derived token -> reject; no ID generation, ownership check, list, hash, clock, or write |
| Reservation | transfer load/authority -> fresh source verification -> source Session `bound -> transitioning` CAS -> crash point -> transfer `prepared -> source_reserved` CAS -> crash point -> transfer `source_reserved -> target_prepared` CAS with canonical Turn path -> crash point -> target Session create with expected revision `null` |
| Dispatch evidence | target/source receipt checks -> transfer `target_prepared -> dispatch_started` CAS -> transfer `dispatch_started -> text_injected` CAS -> transfer `text_injected -> enter_dispatched` CAS; each write consumes the immediately loaded transfer revision |
| Zero-input abort | possible-input guard first -> aborted transfer CAS -> target detach Session CAS -> source restore Session CAS -> `abort_resolved` transfer CAS. Before current-terminal recovery, every Store-authoritative aborted intent is finalized under the existing writer scope without pane/PID/cwd checks or a Turn-state lock, then transfers are listed again and filtered to the current terminal. Recovery with a prepared Turn first persists the aborted Turn receipt, then the resolved safe-to-retry ledger receipt, then performs those transfer/Session CAS writes |
| Accepted commit | transfer/source/target reads and exact authority -> ownership -> optional same-thread source scrub Session CAS -> target accepted Session CAS -> committed transfer CAS -> source detach Session CAS -> target bind Session CAS -> exclusive-owner revalidation -> resolved transfer CAS |
| Uncertain | authority and dispatch-start fence -> clock(s) -> one transfer CAS carrying `do_not_retry: true`; no Session rollback and no terminal retry |
| Committed recovery | transfer/Turn/target/ledger authority -> exact acceptance observation -> accepted Turn state write -> accepted ledger write -> crash point -> source/target/transfer resolution CAS -> accepted Turn identity assertion |
| Possible-input recovery | exact Turn/ledger authority -> one acceptance observation. Durable zero-input proof may enter the abort path; otherwise no abort or rollback is callable. A v3 pending candidate returns without replay, while older pending or observation failure reloads durable transfer authority, records uncertainty at most once, and fails closed |

Turn acceptance remains stronger than later Session and ledger bookkeeping. In
accepted recovery the accepted Turn state is written before Session/transfer
commit and the accepted ledger is written only after the resolved Session
authority and Turn identity checks. If later bookkeeping fails, the accepted
Turn is retained and the failure path records stalled/uncertain durable
evidence; terminal input is never replayed. All transfer writes use explicit
revision CAS, Session writes use the immediately observed managed-Session
revision, target creation uses `null`, and no list token is reused as mutation
authority: mutation always re-observes the canonical post-lock terminal and
binding authority.

Four fast direct files provide the fake-port order, route, capability, and
transition tables. They cover stale-token revalidation, request/boundary
runtime shape, revision/clock order, possible-input never-abort behavior,
single-observation recovery, durable reload before uncertainty, status routing,
multiple-candidate rejection before state scope, cross-terminal abort cleanup
before fresh matching, stable reservation-boundary CAS facts, canonical resource failures,
non-public scope construction, and every-method released-scope failure. The
five retained targeted integration witnesses are Codex no-rollout binding,
dispatch authority, dispatch recovery, Session acceptance, and terminal send
gates.

## Terminal list and selector CLI facade

The terminal-list slice moves raw Store, managed-Session, managed-Turn,
terminal/process, dispatch-ledger, and approval observations out of
`cli-core.ts` into `terminal-list-cli-adapter.ts`. The adapter owns only CLI
composition and infrastructure projection. Existing terminal action,
authority, binding, dispatch, approval, and list-renderer modules remain the
unique decision owners; the facade does not copy their reducers, tokens,
identity classifiers, conflict precedence, or approval rules.

The exported facade has five cohesive, explicitly typed dependency groups:
reconciliation, terminal discovery, Store observation, authority observation,
and policy configuration. `cli-core.ts` constructs one local facade and routes
list and selector work through it. Each facade call installs its own immutable
dependency set in an async-local execution context. There is no mutable module
configuration or catch-all `(...args: any[]) => any` runtime port, and the only
runtime export from the adapter is `createTerminalListCliFacade`.

The direct concurrency witness runs facade A's reconciled `runList` and facade
B's selector discovery concurrently, pauses both across independent awaits,
then releases B before A. The observed post-await callbacks remain B's process
source and A's idle reconciler respectively. After both Promises settle, a
second selector call through each facade still observes its own marker. This
locks the per-execution dependency isolation and factory-only entry boundary.

Selector candidate projection is the I/O-free
`terminal-selector-projection-service.ts`; it accepts typed entry facts and one
typed active-status policy. Process elapsed parsing has one I/O-free canonical
owner in `terminal-process-facts.ts`; the process-source adapter compatibility
re-exports it, while the selector service never imports the process-source
module or its `node:child_process` edge. Managed-Session revision is read
directly from `managed-session.ts`. Native Turn identity matching has one
neutral implementation in `terminal-authority-policy.ts`, shared by list and
dispatch; the dispatch module keeps only a compatibility re-export.

Measured against exact head `29219e4f98a6057924feb37ed05a9982e7310695`,
the slice reduces `src/cli-core.ts` from 23,124 to 20,051 physical lines
(-3,073) and changes production TypeScript from 84,241 to 84,907 (+666). The
transparent typed-facade overhead is 21.67% of the core movement. The graph
changes from 90 modules and 417 static import edges to 93 modules and 446
edges, with zero cycles before and after. The terminal-list owner has two
modules and four targeted integration witnesses. The preceding deferred
foreground slice retains its eight-module ownership mapping unchanged.

The stacked composition preserves the deferred foreground authority,
preparation, application, and recovery services as the only owners of their
state machines. Its existing authority-adapter ports now call the terminal-list
facade for managed-Turn attention, transition state, and terminal-incarnation
blocking facts; no old inline deferred reducer was restored during the rebase.

The infrastructure adapter is a reviewed exception to the preferred
100-line/complexity-20 function target because its staged observation
functions preserve existing Store/terminal/error priority and getter
short-circuits. Its maximum function span is the 298-line/c43 binding
observation, and its highest conservative approximate complexity is c44 in the
139-line handoff observation. Public rendering is 256/c42, terminal discovery
entry composition is 227/c39, and scoped approval resolution is 221/c36. All
remain below the hard 500-line/c50 boundary. The pure selector service peaks at
42/c11 and the process fact parser at 24/c9.

Direct fast proofs preserve exact selector JSON bytes and key insertion order,
mutation-disabled lazy `available_actions` reads, approval fallback getter
order and action target, canonical native-identity getter order, and concurrent
facade isolation. Focused list, delegate, Session-selector, action projection,
and process-source witnesses retain Store/terminal/error priority, the second
Session lookup on mismatch, stale-list versus fresh-mutation separation, and
public token bytes.
## Generic CLI file-lock infrastructure

The synchronous generic file-lock protocol now lives in
`file-lock-cli-adapter.ts`. The adapter owns only exclusive private-file
creation, stale-owner probing, reclaim-guard cleanup, token-matched release,
and legacy owner decoding. Store leases, terminal routing, lifecycle ledgers,
monitor ownership, callback policy, and deferred-transfer decisions remain in
their existing owners.

The factory receives typed clock, PID, sleep, nonce, process-signal, and
filesystem ports and retains no mutable global configuration. `cli-core.ts`
binds its existing async-local clock/PID/sleep functions once; those functions
still resolve the active command context at each lock call. All 28 acquisition
call sites keep the same lock path, timeout/retry options, returned release
closure, and surrounding `try`/`finally` order. The one stale probe and one
owner read also retain their previous query inputs and results.

Against exact parent `59983e63c8e5569d27e6396dc0961433e3a6ec34`, the move
reduces `cli-core.ts` from 20,051 to 19,901 physical lines (-150). The new
infrastructure module is 192 lines, so production grows from 84,907 to 84,949
(+42, below both the 50-line target and the 150-line core movement). Direct
recording tests lock acquisition/write/close/release order, live-owner timeout
cleanup, dead-owner reclaim-before-retry, and descriptor close-before-error
propagation. No file-lock behavior or error precedence changes.

## Ordinary terminal command CLI facade

The ordinary-command slice moves send, respond, approve, exclusive replay,
and dispatch composition out of `cli-core.ts` into
`terminal-command-cli-adapter.ts`. Cancel, renew, close, monitor, lifecycle,
callback, and deferred-foreground state machines remain with their existing
owners. The adapter composes the existing terminal-dispatch execution,
application, capability, receipt, deferred-foreground, terminal-list, and
file-lock factories; it does not introduce a second reducer or authority
decision.

The only runtime export is `createTerminalCommandCliFacade`. Each invocation
runs with an immutable dependency set in async-local context, so concurrently
awaiting facades cannot observe one another's ports. The emitted command-facade
declaration contains neither `any`, `Record<..., any>`, nor
`ResolvedTerminalConversation`. Every callback has explicit parameters and
results. `TerminalDispatchTerminal` is only a structural, CLI-infrastructure
carrier for `conversationId`, `agent`, `pid`, and `terminalControl`; it does
not claim to remove extra properties from the runtime object.
`TerminalControlSendRequest` now uses a six-field
`TerminalControlSendOptions extends Record<string, unknown>` boundary covering
only the timeout, polling, scrollback, and Claude-home values read by dispatch.
The structural terminal carrier and concrete deferred adapters remain
CLI-infrastructure values, not business-service requests.

Every actual deferred business-service request still crosses the explicit
`projectDeferredForegroundTerminalFacts()` literal projection. The direct
preparation-service witness fixes the request and boundary `Object.keys`, and
proves that neither `adapter` nor `terminalControl` crosses that boundary.
Terminal-dispatch execution receives typed facts and ports, while dispatch
application and capability receive authenticated routes/repositories; none of
the three receives the concrete terminal carrier.

Measured against exact parent
`921636a4a86da8d565c659bdcbb64021ac112366`, the slice reduces
`src/cli-core.ts` from 19,901 to 16,350 physical lines (-3,551) and changes
production TypeScript from 84,949 to 86,473 lines (+1,524). Typed production
overhead is 42.92 percent of core movement, leaving 2,027 lines of movement
margin. The production graph has 46 domains, 95 modules, 482 static import
edges, and zero cycles. `cli-core.ts` retains one production importer. The
ordinary-command owner has one module and exactly five focused integration
witnesses.

The extraction preserves three critical transaction shapes. Replay validates
ledger receipt history before active-ledger authority, validates every stored
match (including getters and conflicting safe-abort receipts) before filtering
retryable zero-input receipts, validates the durable log body, and presents
inside the canonical mutation callback. Transport failure may call the
zero-input reducer only when no text timestamp exists and the error is
`TerminalInputNotStartedError`; every possible-input failure instead records
uncertainty, emits `do_not_retry`, and presents the uncertain receipt. Managed
approval holds the terminal lock across observation, reservation, key
dispatch, durable resolution, monitor handoff, and JSON presentation. Its
state lock is released before monitor launch as before, while a failed
`beforeKeyDispatch` leaves the reserved uncertain marker and sends no key.

The following infrastructure functions are reviewed exceptions to the
preferred 100-line/c20 target. Counts use the same conservative physical-span
and nested-function-excluding complexity method as this document; every entry
remains below the hard 500-line/c50 gate.

| Function or nested stage | LOC / approximate complexity |
| --- | ---: |
| `runManagedApprovalDispatch` | 486 / c2 |
| `runRawTerminalSend` | 443 / c2 |
| raw-send canonical mutation callback | 419 / c45 |
| `runApprovalWithStateLock` | 393 / c30 |
| `replayExactActiveTerminalSubmission` | 276 / c41 |
| `runManagedSessionSend` | 265 / c21 |
| `resolveTerminalDispatchSubmissionOwner` | 261 / c43 |
| `prepareTerminalControlSend` | 255 / c42 |
| `runTurnResponse` | 223 / c11 |
| `replayExactStoredTerminalSubmission` | 188 / c22 |
| managed-send mutation callback | 186 / c21 |
| `runApprove` | 177 / c32 |
| respond outer mutation callback | 164 / c1 |
| `runTerminalConversationApprove` | 162 / c10 |
| respond state callback | 153 / c22 |
| `validateStoredTerminalSubmissionMatch` | 150 / c28 |
| `createTerminalDispatchRuntime` | 148 / c4 |
| approval `beforeKeyDispatch` callback | 132 / c31 |
| `runTerminalControlSend` | 105 / c9 |
| `runTerminalDispatchTransport` | 106 / c7 |
| raw-send state callback | 103 / c4 |

The evidence map deliberately reuses the direct tests of the unique dispatch
owners instead of copying their state machines into facade tests:

| Contract | Direct proof | Focused real-CLI proof |
| --- | --- | --- |
| Factory-only typed ports and await isolation | `terminal-command-cli-adapter.test.ts` fake-port trace | all five owner files exercise the bound production factory |
| Replay receipt/log bytes, getter validation, error priority, and locked presentation | facade compiled-wiring proof; `terminal-dispatch-receipt.test.ts` exact bytes | `agent-cli-composer-replay.test.ts` exact output/log body and no second Enter |
| Possible input never becomes zero-input retry | facade failure-wiring proof; `terminal-dispatch-application.test.ts` text-progress table; `terminal-dispatch-execution.test.ts` one-Enter table | `agent-cli-dispatch-authority.test.ts` retryable pre-input versus uncertain post-input receipts |
| Approval uncertain reservation and terminal-lock lifetime | facade lock-wiring proof; `terminal-agent-bridge.test.ts` reservation/callback/no-key order | `agent-cli-claude-callback.test.ts` and `agent-cli-control-locks.test.ts` |
| Native acceptance and dispatch-owner authority | execution/application fake-port tables | `agent-cli-session-acceptance.test.ts` |
| Runtime stripping at the service boundary | `deferred-foreground-preparation-service.test.ts` exact request/boundary keys | the Session-acceptance witness traverses the same production projection |

The five selected focused files are composer replay, dispatch authority,
control locks, Claude callback, and Session acceptance. They cover replay,
send/possible-input, approval, lock order, and native acceptance without adding
lifecycle, close, monitor, or callback ownership to this facade.

## Terminal dispatch repository and recovery

The terminal dispatch recovery slice moves the raw ordinary-ledger repository,
prepared and lagging crash reconciliation, verified-dead reconciliation, and
callbackless local-completion settlement out of `cli-core.ts`. Ordinary
send/respond/approve dispatch, deferred foreground transfer state machines,
native lifecycle policy, monitor polling and callback transport remain in their
existing owners. The composition root keeps the narrow callback-outbox
preparation closure and routes the old helper names through one invocation-safe
facade.

Measured against exact parent `9156a7d45c28b8d9a428fbd048c46cf2226d56aa`,
the slice reduces `src/cli-core.ts` from 16,350 to 14,390 physical lines
(-1,960) and changes total production TypeScript from 86,473 to 87,562 lines
(+1,089, 55.56% of the core movement). The three-module ownership domain has five
targeted integration witnesses. Architecture validation reports 98 production
modules, 515 static import edges, and zero cycles.

The 410-line repository adapter is the sole owner of dispatch-ledger filesystem
paths, raw bytes, legacy/canonical filenames, the dual lock set, file modes,
directory fsync, and atomic replace. Its 321-line/c1 factory is a reviewed
exception to the preferred 100-line function target; its largest inner
operation is the 73-line/c18 save. The 791-line recovery service exposes exactly
five typed port groups (`transaction`, `authority`, `evidence`, `state`, and
`completion`), has a 47-line maximum function and c12 maximum complexity, and
imports no Node filesystem/path API, CLI core, Store/session persistence, raw
lock or JSON helper, `Record<..., any>`, full resolved terminal, or terminal
adapter capability. The 1,848-line CLI transaction adapter owns path projection,
Session/event reads, Store-writer and state locking, callback preparation, and
legacy record validation. Its largest function is 77/c17. The reviewed
complexity exception is the 37-line/c30 exact ledger-receipt predicate; every
function remains below the hard 500 LOC/c50 gates, and the facade factory is
24/c1.

Repository compatibility remains fail closed. A canonical terminal acquires
the canonical and legacy send locks in lexical order and releases them in
reverse order through an idempotent closure. Reads reject symlinks and non-files
without following the final path and reject simultaneous canonical/legacy
owners. A validated legacy ledger is renamed to its canonical owner and the
directory is synced before the next version-2 replace. Every replace creates a
0600 exclusive temporary file, writes the exact pretty-JSON-plus-newline bytes,
fsyncs the file, renames, reapplies 0600, fsyncs the directory, and removes any
temporary artifact. Receipt history remains append-preserving across migration
and settlement; a failed conversation/message CAS leaves the original bytes
unchanged. Restoring a prior durable generation replaces the top-level document
while retaining its append-only receipt history, so the abandoned generation
cannot leak a self-referential `previous_generation_id`.

Recovery retains `terminal dispatch lock -> Store writer lease -> Turn state
lock`. Prepared keep decisions do not sample the clock, and owner mismatch
returns before Store/binding projection. Prepared recovery resolves only when
durable evidence proves zero input was possible; text-injected,
Enter-dispatched, submitted, accepted, and uncertain proof is reconciled
without terminal replay. Fresh verified-dead recovery applies the basic ledger
fence first, then short-circuits state, Store, full ledger, receipt, and
acceptance observations in order. It reuses or observes one process-death proof
and lets a newly observed durable completion win before writing stall evidence.
Stall persistence remains `death event -> stalled event -> crash fence -> state
-> runtime log`. Completion preparation releases the state lock while retaining
terminal and writer ownership; a failed release is retried by the enclosing
transaction cleanup before writer and terminal release. Local completion
verifies the exact claim, detected event,
message event, accepted submission, and ledger before `resolve ledger -> settled
event`. Reload, projection, and callback errors still unwind state, writer, then
terminal ownership.

Direct fast evidence fixes legacy promotion, canonical bytes and 0600 mode,
receipt preservation, canonical/legacy conflict rejection, dangling-symlink
rejection, dual-lock cleanup, failed-CAS byte identity, verified-dead completion
and stall write order, callbackless settlement idempotence, zero-input-only
prepared resolution, no replay surface, five-port boundary hygiene, and all-lock
cleanup after a locked reload failure. It also fixes replacement-document
Object keys and bytes, lazy-observation call counts and reason strings, and a
release-error retry. Existing dispatch recovery, receipt
fence, control-lock, monitor recovery, and human-handoff suites remain the
black-box boundary set.

## Terminal runtime and provider CLI composition

The runtime/provider slice moves command-scoped terminal-control provider
selection, process-source selection, Codex/Claude adapter registry composition,
bridge construction, Claude `agents --json --all` observation, running-agent
version observation, and provider-owned takeover decoding into
`terminal-runtime-cli-adapter.ts`. Exact-bound Codex completion policy, native
identity resolution and assertion, Store-backed runtime identity, durable
request construction, endpoint refinement, legacy migration, acceptance,
dispatch, monitor, lifecycle, callback, and deferred foreground work remain in
their existing owners and enter this adapter only through typed callbacks.

The factory receives five invocation-local groups: options, async-local command
dependencies, completion callbacks, opaque identity callbacks, and workspace
validation. It retains no mutable global provider or dependency state. Bridge
defaults are still evaluated lazily in provider -> agent registry -> process
source order. Injected providers and sources still win before static fixtures;
the original option truthiness rules are unchanged. Concrete raw JSON parsing
and `spawnSync` calls stay in this CLI infrastructure adapter rather than
crossing a service boundary. Claude keeps the exact
`agents --json --all` argv, status/error handling, invalid-JSON diagnostics,
required-observation refusal, and row normalization order. Running-version
observation keeps injected -> per-PID fixture -> per-agent fixture -> exact
`lsof` executable-path evidence priority.

Against exact parent `779e2e5d15ff18c5b8d0c5bbb7493e601f06cfb3`, the
required top runtime movement plus the independent agent-version adapter reduce
`src/cli-core.ts` from 14,390 to 13,935 physical lines (-455). Production
TypeScript changes from 87,562 to 87,718 lines (+156, 34.29 percent of the core
reduction), meeting the preferred overhead target and remaining below the 518
lines of gross responsibility movement. The graph has 48 domains, 99 modules,
526 edges, and zero cycles. The generated adapter declaration has no `any`,
`Record<..., any>`, or `ResolvedTerminalConversation`; the module imports no
Store, identity-authority, acceptance, dispatch, monitor, lifecycle, callback,
or deferred module. Every adapter function is below 100 physical lines and
approximate complexity 20; the maxima are 47 lines and c15.

Direct fast proofs lock factory laziness and instance isolation, exact provider
-> registry -> process-source getter order, injection/static truthiness,
exact-bound completion short-circuiting, Claude subprocess argv and fail-closed
errors, agent-version precedence, and tmux/Herdr takeover decoding. Its targeted
owner selects five retained CLI witnesses spanning Claude native inspection,
facade import laziness, lifecycle versioning, send gating, and native Session
acceptance. The 8,997-line Codex no-rollout fixture is deliberately excluded:
these narrower witnesses cover this composition boundary without selecting the
integration tier's dominant runtime for every adapter edit.

## Native acceptance and managed Turn application

The acceptance slice moves native acceptance composition, virgin Codex
post-submission binding recovery, monitor acceptance reconciliation, uncertain
settlement, managed Session identity refinement, managed Turn queries, and
managed Turn construction out of `cli-core.ts`. The new CLI adapter composes the
existing `TerminalDispatchExecutionService`, terminal-submission detectors,
receipt merger, deferred-foreground recovery owner, and terminal-dispatch
repository/recovery facades. Ordinary ledger locking, reads, and writes are
projected directly from `terminalDispatchRepository`; prepared reconciliation
and binding proof are projected directly from `terminalDispatchRecovery`. It
obtains the command-local terminal runtime lazily and uses its existing Claude
row and bridge ports instead of rebuilding provider composition. It does not
copy acceptance scanning, receipt ranking,
ledger repair, authority tokens, or deferred-transfer reducers.

`TerminalAcceptanceApplicationService` owns the ordered
recover -> detect -> optional second recovery -> second detect -> exact draft
proof -> commit decision. `ManagedTurnRecoveryService` owns the monotonic virgin
binding sequence: validate literal facts, resolve the exact identity, require
the canonical acceptance detector when neither side was committed, prove
exclusive ownership, commit Session identity, commit Turn identity, then
revalidate the Turn. Both services receive at most five typed port groups and
import no filesystem, path, Store/session repository, raw lock, raw JSON,
`Record<..., any>`, `ResolvedTerminalConversation`, or terminal adapter
instances.

The CLI adapter retains the concrete resource discipline. Virgin recovery is
terminal lock -> Store writer -> Turn state lock; monitor acceptance already
holds the same terminal lock and therefore enters only writer -> state. Final
acceptance writes Turn state before best-effort ledger and event bookkeeping,
while uncertainty retains the legacy ledger -> Turn state -> event durable
order. An `enter_dispatched` Turn with possible input never enters a replay or
zero-input abort path: absent acceptance stays pending unless the exact draft
is still present, in which case it becomes durable `not_accepted` with
`do_not_retry` authority.

Managed Turn construction retains the original insertion order and exact
storage-path suffix, binding id/generation, native identity, endpoint evidence,
message metadata, and optional deferred transfer id. The public adapter
declaration contains neither `any`, `Record<..., any>`, nor
`ResolvedTerminalConversation`; deferred operations cross only the structural
`TerminalDispatchTerminal` carrier.

Measured against exact parent
`6318a3bbff2ec0aa10baa3ada8313d1eed038bd2`, this slice reduces
`src/cli-core.ts` from 13,935 to 12,721 physical lines (-1,214) and changes
production TypeScript from 87,718 to 88,732 lines (+1,014). The typed overhead
is 83.53 percent of core movement and remains 200 lines below the hard
movement ceiling; it does not meet the preferred 450-line overhead target, so
that tradeoff is explicit. The production graph has 49 domains, 102 modules,
559 static import edges, and zero cycles. `cli-core.ts` retains one production
importer, and the acceptance owner retains exactly five integration witnesses.

All extracted functions remain below the hard 500-line/c50 gates. The two
reviewed preferred-target exceptions use the documented nested-function-
excluding complexity method: `#recoverVirginLocked` is 104 physical lines/c2,
and `attachManagedTurn` is 75 lines/c23. Every business-service function stays
below 100 lines and c20.

The direct evidence fixes the critical boundaries:

| Contract | Direct proof | Focused real-CLI proof |
| --- | --- | --- |
| Virgin acceptance order and split CAS recovery | recording ports prove detector -> ownership -> Session -> Turn -> revalidation and both one-sided crash continuations | no-rollout binding and Session-acceptance shards |
| Possible input never replays | application table proves pending without exact draft and `not_accepted` only with exact draft | Session acceptance and terminal-send gates |
| Terminal -> writer -> state and durable write order | compiled facade wiring checks both lock stacks plus accepted and uncertain writes | monitor-recovery and no-rollout binding |
| Managed Turn JSON shape | direct exact key/order/binding/message projection | handoff and Session-acceptance shards |
| Data-only service boundary | declaration/source prohibition test and at-most-five-group typed ports | all five owner witnesses traverse the production facade |

The five focused witnesses are Codex no-rollout binding, human handoff,
monitor recovery, Session acceptance, and terminal send gates. Together they
cover virgin and deferred acceptance, process drift/quarantine, crash recovery,
uncertainty, Turn construction, and no-replay behavior without assigning
lifecycle, callback, or generic ledger-recovery ownership to this slice.

## Terminal identity authority CLI composition

The identity-authority slice moves the exact 37-function inventory for terminal
routing, process-incarnation and verified-dead observation, managed Session
logical/native identity, Codex companion and pre-materialization fences,
binding selection/conflict/materialization/reattach, and verified-empty deferred
authority observation out of `cli-core.ts`. It deliberately leaves submission
acceptance refinement/persistence/quarantine, current-native-identity polling,
managed Turn creation, deferred detach/adoption state machines, repository,
monitor, callback, and lifecycle mutation in their existing owners.

Against exact parent `918812c5b541d5586595c4ea793df370f538d3e4`,
`src/cli-core.ts` falls from 12,721 to 11,468 physical lines (-1,253). Total
production TypeScript changes from 88,732 to 89,156 (+424, 33.84 percent of the
core movement), below the preferred 450-line overhead target. Architecture
validation reports 50 domains, 104 production modules, 589 static import edges,
and zero cycles. The factory has four explicit invocation-scoped groups
(`runtime`, `store`, `authority`, and `environment`) and exports no singleton or
mutable process-global runtime. The composition root projects provider ports
directly from `terminalRuntime(options)` and acceptance-owned identity/Session
ports directly from `terminalAcceptanceCliFacade`; it adds no interim owner.

The 78-line data-only service receives only projected native identity, process
incarnation, companion, revision, status, and binding-token facts. It imports no
filesystem/path/process-source, Store, managed Session, resolved terminal, raw
JSON, lock, or `Record<..., any>` API. It owns only the moved exact-lifecycle
fallback, deterministic companion uniqueness, and verified-empty snapshot
comparison. The 1,599-line CLI adapter retains provider/process observation,
Store reads, one managed-Session CAS reattach write, and explicit terminal
projection. It reuses `terminal-binding-authority`,
`terminal-authority-policy`, `terminal-dispatch-execution`, action projection,
lifecycle verification, submission acceptance, verified-dead policy, and the
runtime provider rather than copying rollout, fence, token, companion,
status-card, or transition reducers.

Observation and mutation order remain fail closed. Exact bound-process proof
short-circuits envelope, binding, then accepted-submission evidence before
consulting the complete process inventory. Stored status-card identity remains
preferred only under the committed companion/predecessor fence. Codex process
birth lookup stays lazy, and Claude still rejects a missing process UUID before
any fallback. Raw reattach performs exclusive-ownership observation, reloads
the exact Session, revalidates revision plus binding token, then writes one
generation-incremented Session CAS. Verified-empty handoff checks the initial
snapshot, process incarnation, absent native identity, terminal status and
dispatch readiness, then reloads and revalidates the Session before transition
and composer gates. No new lock or durable-file order is introduced.

Every new function meets the preferred limits: the maximum adapter span is 95
lines and the conservative maximum approximate complexity is c17; the service
is smaller. Direct fast proofs cover malformed/fail-closed facts, deterministic
companion selection, lazy process-birth lookup, parallel async-execution
isolation, the four-group factory boundary, and service infrastructure hygiene.
Five retained focused witnesses cover no-rollout/status-card binding, observed
handoff/verified-empty authority, native lifecycle identity, Session acceptance,
and terminal-send gates. The remaining exact-bound completion detector and
requirement predicate stay with completion/recovery composition; endpoint
refinement, Store-backed runtime identity, durable request construction, and
legacy identity migration remain a later minimal identity-facade prerequisite
rather than being duplicated here.

## Terminal runtime prerequisites and exact completion authority

The follow-up prerequisite slice closes that deliberately deferred inventory.
The single exact-bound Codex completion detector and requirement predicate now
live in `terminal-dispatch-completion-cli-adapter.ts`; neither the raw dispatch
repository nor recovery adapter imports it. The detector retains
accepted-submission -> exact-required -> Codex-source -> exact-anchor -> bound
rollout detection order, while its synthetic-acceptance switch is read lazily
from the invocation-local CLI environment. Exact completion still uses the one
`detectCodexBoundRolloutCompletion` implementation and preserves request-hash
fallback, byte identity, diagnostics, pending behavior, and completion metadata.

Endpoint refinement, Store-backed runtime identity, durable request projection,
and legacy terminal-agent identity migration are now methods of the existing
identity facade. The earlier temporary `runtimeIdentity` and `durableRequest`
callback ports are gone. A fifth typed completion group supplies only the exact
requirement predicate. Runtime identity still checks binding id, generation,
native thread, PID, terminal incarnation, and committed Codex companion fences
before expanding its authority. Durable requests continue to prefer takeover
request text and metadata. Endpoint refinement associates and saves only
canonical evidence for the same terminal incarnation.

Legacy migration is split into observation, locked persistence, and reporting
functions. Only provider/process observation is downgraded to a warning. The
state lock still encloses reload, revalidation, and save; every path releases it
in `finally`. A successful save is followed, outside that lock, by durable event
append and then runtime logging. Save and event failures propagate. The runtime
facade also owns Codex Session-provider selection and active-Session terminal
attachment, preserving injected-provider and injected-adapter precedence,
fixture truthiness and JSON parsing, production Store fallback, and the original
provider/process-source/bridge construction counts.

Against exact parent `6c83f9efe5b3201c584db3ad2b50cd9e120310ad`,
`src/cli-core.ts` falls from 11,468 to 11,066 physical lines (-402). Production
TypeScript changes from 89,156 to 89,264 lines (+108, 26.87 percent of the core
reduction), below the preferred 160-line overhead target and the 240-line hard
cap. Architecture validation reports 51 domains, 105 production modules, 596
static import edges, and zero cycles. The three changed facade declarations
contain no `any`, `Record<..., any>`, or `ResolvedTerminalConversation`. New
functions are below 55 physical lines and approximate c20; the expanded identity
facade retains its pre-existing 95-line/c17 maxima, below both hard limits.

Direct fast proofs cover dynamic synthetic environment lookup; accepted, source,
anchor, and real byte-detector order; exact binding/generation/thread/PID/
incarnation and companion fences; takeover-first durable requests; canonical
endpoint save; observation-only warning behavior; lock/reload/save/unlock/event/
log order; save and event error propagation; provider injection, fixture
truthiness, JSON validation, and active provider/source/bridge call counts. Four
targeted integration witnesses retain exact monitor recovery, Session acceptance,
terminal send gates, and import-time facade wiring.

## Native lifecycle context, listing, and inspection CLI composition

The native-lifecycle Vertical A slice moves the exact 21-function inventory for
binding tokens, lifecycle terminal resolution, query-port composition,
workspace and exclusive-ownership observation, current lifecycle snapshots,
resumable-thread listing, and the closed native status inspection out of
`cli-core.ts`. It also moves terminal Store-authority and orphan projections
behind the typed dispatch-recovery facade and keeps Codex latent-clear parsing,
composer checks, and candidate-provider precedence in one command-scoped CLI
adapter. Native new/resume/reconcile transition, recovery, verification,
settlement, deferred handoff, acceptance, callback, and monitor state machines
remain in their existing owners.

Against exact parent `81feac294d5a62ea8309c6e96a66c042ebf239b8`,
`src/cli-core.ts` falls from 11,066 to 9,868 physical lines (-1,198). Total
production TypeScript changes from 89,264 to 89,498 (+234, 19.53 percent of the
core movement), below the preferred 350-line and hard 550-line overhead limits.
Architecture validation reports 51 domains, 106 production modules, 615 static
import edges, and zero cycles. The factory has exactly five explicit,
invocation-scoped groups (`runtime`, `identity`, `state`, `terminalList`, and
`output`) and exports no mutable singleton. Codex lifecycle-candidate selection
delegates directly to the runtime facade's dedicated provider factory, retaining
the invocation-local override before production Store fallback.

`currentSnapshot` is the only lifecycle snapshot sequencer. It resolves the
claimed Codex companion context through `terminalIdentityAuthority`, observes
the current native identity through `terminalAcceptanceCliFacade`, selects or
materializes the managed Session, refines it through the acceptance owner when
requested, derives the logical identity and companion set through the identity
facade, performs exclusive ownership before returning a frozen data-only
snapshot, and never returns a terminal adapter. Vertical B requests adapter
behavior separately through the facade, so no full terminal or executable
capability leaks into snapshot facts.

Native inspection retains the exact safety boundary: the terminal lock remains
held through output presentation; `/status` is the only accepted plan; Enter is
dispatched exactly once; a fresh terminal, binding token, agent version,
identity, ownership, readiness, and composer are revalidated immediately before
Enter; two consecutive fresh observations with the same evidence fingerprint
are required; modal dismissal revalidates the same facts immediately before its
single key sequence; and final status plus empty-composer proof precedes output.
Only a pre-input `NativeInspectionSubmissionError` remains safely retryable;
possible input and every post-Enter uncertainty retain the do-not-retry result.

The TypeScript compiler AST inventory contains 68 functions in the new adapter;
every one stays below the preferred limits (maximum 64 physical lines and
approximate complexity c14). Direct evidence
fixes canonical and legacy binding-token bytes plus double getter order,
snapshot sequencing and exact data-only keys, one-Enter/two-observation/final-
revalidation ordering with lock-held presentation, parallel async provider
isolation, the five-group factory boundary, and declaration/core forbidden
patterns. The four focused witnesses are Claude native inspection,
native-thread lifecycle, native ownership, and the Codex no-rollout native-
inspection cases.

## Deferred foreground and observed handoff CLI facade

This slice moves the exact 23-function deferred/verified-empty/observed-handoff
inventory (1,733 physical function-span lines) out of `cli-core.ts`. It owns
safe-aborted deferred retry validation, verified-empty detach and transport
boundaries, deferred preparation/application/recovery composition, observed
handoff token/selector/target/adoption/transport boundaries, and nonterminal
transfer guards. Ordinary replay, deferred reducers and repositories,
submission acceptance, identity authority, lifecycle commands, callbacks,
monitoring, and `runObservedHandoffClose` remain with their existing owners.

Against exact parent `d4cb4f108ce240a006c7eebb56e2ce5cc9d70c3f`,
`src/cli-core.ts` falls from 9,868 to 8,119 physical lines (-1,749). Total
production TypeScript changes from 89,498 to 89,873 (+375), meeting the
preferred 450-line overhead target and the 1,650–1,850 core-reduction target.
Architecture validation reports 52 domains, 109 production modules, 643 static
import edges, zero cycles, and one retained `cli-core.ts` importer. The new
owner has three modules and exactly five focused integration witnesses.

`terminal-handoff-facts.ts` and `TerminalHandoffApplicationService` own only
neutral zero-input chronology and ordered authority-thunk evaluation. They
import no filesystem/path API, Store or Session repository, locks, raw JSON,
full terminal object, or `Record<..., any>`. The CLI adapter retains concrete
terminal, Session, ledger, and path translation. Its invocation-local factory
has exactly five groups (`runtime`, `identity`, `acceptance`, `authority`, and
`repository`); repository includes the already-authenticated transaction-shell
operations. `identity` is the actual `terminalIdentityAuthority` facade type,
not a copied identity port list. Acceptance observation and Turn checks remain
direct projections of `terminalAcceptanceCliFacade`.

The recovery seam is explicit for downstream lifecycle composition.
`recoverDeferredCodexForegroundTransferBeforeMutation` is entered while the
caller owns the exact terminal lock; it creates the canonical transaction scope
with a no-op terminal acquisition, then acquires the Store writer lease.
`recoverDeferredCodexForegroundTransferWhileWriterLease` accepts the resulting
typed canonical scopes/resources, and only `withDeferredForegroundRecoveryScope`
may add the conversation state capability. Transfers without a state path use
the writer capability directly. Thus the retained order is terminal -> writer
-> state, and no service reconstructs a raw lock or held-lock flag. Fresh
handoff identity/status observation is exposed as the invocation-scoped
`observedExternalHandoffIdentity`; known roots and companions remain the
invocation-scoped `terminalIdentityAuthority` operation rather than being
reconstructed here.

Safe retry remains fail closed. Only an exact `aborted` receipt with
`safe_to_retry=true`, zero-input chronology, canonical state/log paths, exact
terminal route and process incarnation, one byte-identical canonical receipt,
matching request hash, resolved zero-input ledger, and exact restored Session
CAS authority may retry. A possible-input stage never takes this route.
Verified-empty detach revalidates the source snapshot and identity boundary
before its Session CAS. Observed adoption retains the durable order `prepared
transition -> prepared ledger -> source transitioning -> fresh observation ->
verified transition -> verified ledger -> Session commit -> committed
transition -> resolved ledger`. Once the durable transition is verified or
committed, catch handling rethrows and never downgrades it to uncertain.

The two previously over-complex boundaries are now below the hard gate:
safe-aborted retry is 148 lines/c9 and observed-handoff transport is 166/c28.
The reviewed preferred-target exceptions are:

| Function | LOC / approximate complexity |
| --- | ---: |
| `maybeAdoptObservedExternalThread` | 322 / c35 |
| `assertObservedHandoffTransportBoundary` | 166 / c28 |
| `prepareDeferredCodexForegroundBinding` | 152 / c2 |
| `safeAbortedDeferredRetrySourceSession` | 148 / c9 |
| `recoverDeferredCodexForegroundTransferWhileWriterLease` | 123 / c1 |
| `maybeDetachVerifiedEmptyCodexSource` | 104 / c9 |

Direct fast evidence records parallel factory/capability isolation, selector
WeakMap isolation, getter and original-error priority, zero-input chronology,
canonical receipt/hash/route byte ordering, monotonic handoff writes,
verified-state non-downgrade, terminal/writer/state capability order, neutral
service imports, and direct identity-facade composition. The five retained
focused witnesses are Codex no-rollout binding, human handoff adoption,
dispatch recovery, Session acceptance, and terminal-send gates. They cover the
real verified-empty, deferred crash/retry, observed adoption, acceptance, and
pre-input transport paths without assigning lifecycle, callback, monitor, or
ordinary replay ownership to this facade.

## Callback CLI and outbox composition facade

The callback CLI slice moves the exact nine-function command, transaction,
outbox-composition, prepared-result presentation, process-delivery recording,
and OpenClaw transport inventory out of `cli-core.ts`. The new
`callback-cli-adapter.ts` remains raw CLI infrastructure: it delegates every
callback transition to the existing callback outbox service, settlement,
policy, and OpenClaw transport owners and introduces no callback state machine.
The outbox service boundary changes only mechanically from six port groups to
five by placing `resolveCompletionDispatch` beside the other authority ports.

Against exact parent `0c2d4258094f47302bc8265eb98d4a05f5b44305`,
`src/cli-core.ts` falls from 8,119 to 7,941 physical lines (-178). Total
production TypeScript changes from 89,873 to 89,933 lines (+60, 33.71 percent
of the core movement), meeting the preferred 60-line overhead target and the
120-line hard cap. Architecture validation reports 52 domains, 110 production
modules, 651 static import edges, and zero cycles. The 240-line adapter has four
invocation-scoped groups (`state`, `authority`, `retry`, and `runtime`), exports
only its factory at runtime, and uses async-local binding rather than mutable
process-global configuration. Its declaration contains no `any`,
`Record<..., any>`, or resolved-terminal capability.

The transaction chronology is unchanged. A normal callback holds writer then
state authority through required-message validation and outbox preparation,
releases state then writer, and only then performs delivery and presentation.
A manual retry loads its selected Turn, takes writer authority, reloads the
fresh Turn, applies the canonical handoff facade's nonterminal-transfer fence,
releases the writer, and only then enters accepted recovery or retry delivery.
Settlement keeps its existing state transaction. Delivery never holds either
outer lock. Fresh preparation retains message-before-path/Store validation and
the existing message/event/monitor/state/runtime-log sequence; progress,
accepted transport, success, failure, and bounded retry remain owned by the
unchanged outbox service and settlement. Accepted transport followed by an
observation error still settles as delivered. Process delivery still appends
the redacted durable event before its redacted runtime log.

All adapter functions stay within the preferred limits (maximum 34 physical
lines and approximate c2, excluding nested function bodies). Direct recording
tests prove writer/state release before presentation, fresh deferred fencing
before retry, accepted-transport recovery, nested facade isolation, compiled
lock and redaction order, the four-group boundary, factory-only exports, and
declaration prohibitions. The focused real-CLI witnesses remain callback CLI,
Claude callback, monitor approval context, and monitor recovery; they exercise
ordinary and recovered single emission, retry, completion/approval preparation,
transport acceptance, and monitor consumption without duplicating callback
authority.

## Native lifecycle transition application

This slice moves the exact 13-function native lifecycle transition inventory
(1,344 physical function-span lines) out of `cli-core.ts`. The new
`native-thread-transition-application.ts` owns new-thread, exact resume,
binding reconciliation, pre-mutation lifecycle recovery, transition
settlement composition, and terminal-ready verification. The separate
`native-thread-lifecycle-ledger-cli-adapter.ts` owns exact lifecycle ledger CAS
against the existing terminal-dispatch repository. Candidate query,
verification, settlement, recovery, ledger codec, identity, acceptance, and
Session repositories remain with their existing owners; no reducer or
repository is copied.

Against exact parent `98e3566f0e15e4a6ff0ffff6efa85cdde532ee77`,
`src/cli-core.ts` falls from 7,941 to 6,483 physical lines (-1,458). Total
production TypeScript changes from 89,933 to 90,578 (+645), inside the hard
650-line overhead gate. Architecture validation reports 52 domains, 112
production modules, 669 static import edges, zero cycles, and one retained
`cli-core.ts` importer.

The invocation-local CLI bounded I/O shell composes exactly five port groups
(`runtime`, `lifecycle`, `state`, `authority`, and `mutation`). It extends the
existing lifecycle query facade at the CLI composition root. Observed handoff
identity and writer-scope deferred recovery call the merged terminal-handoff
facade directly; verified-empty detach and transport continue through that
same facade. Recovery services receive only projected terminal facts plus scoped
capabilities. Binding reconciliation likewise receives data-only terminal and
status facts, while the CLI adapter retains the exact runtime terminal needed
for subsequent infrastructure calls.

The mutation sequence remains terminal lock -> Store writer lease. A fresh
terminal route is re-resolved after both capabilities are authenticated.
Resume snapshot expiry, action fingerprint, and the complete candidate set are
revalidated before persistence and again at their mutation-adjacent fences.
The durable order remains prepared transition -> prepared ledger -> source
transitioning -> dispatching transition/ledger -> input -> submitted
transition/ledger -> verification -> verified transition -> target ownership
-> Session commit -> committed transition -> resolved ledger -> presentation.
Presentation therefore remains inside both locks. Only a
`TerminalInputNotStartedError` with no text-injection observation can take the
zero-input abort path; possible input remains uncertain, quarantined, and
do-not-retry.

Compiler-AST evidence covers every function-like declaration in the new
application. The maximum span is 445 physical lines and maximum approximate
complexity is c44, below the hard 500/c50 gates. Direct tests record exact
ledger load/authority/save precedence, scoped recovery resources, verified
commit and uncertain failure order, resolved-ledger-before-presentation, and
presentation before writer/terminal lock release. Fast and focused lifecycle,
recovery, ownership, Codex sticky-rollout, and stale-resume witnesses retain
the real CLI behavior.

## Terminal monitor state and collateral CLI facade

This slice moves the exact 14-function monitor state inventory plus its
adjacent durable state/fact preparation out of `cli-core.ts`: uncertain-dispatch
collateral fencing and repair evidence, approval notification persistence and
clear, activity and detector diagnostics, stalled-state notification,
callback/local-completion recovery, startup eligibility, and monitor service
port composition. The state facade deliberately does not absorb process-owner
inspection, legacy-owner decisions, watchdog supervision, monitor launch, or
launch-event presentation. Those responsibilities now belong to the subsequent
terminal monitor supervision facade documented below, rather than
`cli-core.ts`.

Against exact parent `240732e4d0a654abb4f88a01020bd93734f0d020`,
`src/cli-core.ts` falls from 6,212 to 4,547 physical lines (-1,665). Total
production TypeScript changes from 90,711 to 91,535 lines (+824, 49.49 percent
of the core movement), so production overhead remains below the moved core.
Architecture validation reports 54 domains, 115 production modules, 712 static
import edges, zero cycles, and one retained `cli-core.ts` importer.

`terminal-monitor-state-reconciliation-service.ts` is data-only and has four
port groups (`state`, `completion`, `callbacks`, and `authority`). It imports no
filesystem/path API, raw lock, Store, Session, resolved terminal, raw JSON, or
`Record<..., any>`. Its reconciliation order remains local completion ->
callback recovery -> terminal-bridge filter -> legacy identity migration ->
verified-dead settlement -> deferred recovery -> virgin acceptance recovery ->
binding assertion -> eligibility. Handled local, callback, dead-process, and
ineligible results stop every later observation.

The CLI adapter has exactly five dependency groups (`dispatch`, `acceptance`,
`authority`, `callbacks`, and `runtime`). It calls the merged
`callbackCliFacade`, terminal-dispatch repository/recovery,
`terminalAcceptanceCliFacade`, `terminalHandoffCliFacade`, and identity
authority directly; it contains no copied callback, deferred, acceptance, or
dispatch reducer. Command-selected Store authority is retained for terminal
send locks, while state-path-derived Store authority is retained for writer
leases, collateral repair, and verified-dead settlement.

The existing monitor application still samples one poll snapshot for status
and screen facts. Prepared recovery preserves terminal -> writer -> state lock
order; presentation stays inside the required lock scope. Approval state is
saved before its event and outbox preparation, duplicate/recovery reads retain
their original order, and approval/stalled callback delivery begins only after
the state and writer locks release. Verified-dead completion calls the canonical
prepared callback exactly once. Superseded binding remains a non-error skip,
the subsequent supervision facade directly classifies raw `LOCK_TIMEOUT` for
only its handoff and singleton process locks, and state/application deferral
retains typed `StoreLockTimeoutError` plus the existing raw
terminal/conversation timeout path.

All new functions remain below the hard 500-line/c50 gates. The transparent
preferred-limit exceptions are the 209-line/c1 service-port composition table,
the 122-line/c47 fail-closed collateral evidence predicate, and its
64-line/c22 exact owner predicate; splitting either evidence predicate would
obscure its ordered short-circuit proof. The data-only service maximum is
63 lines/c8. Direct fast tests record resource identity and post-scope data,
exact port/getter/error order, optional zero/null fields, prepared completion
byte facts, canonical facade wiring, four/five-group declarations, and
forbidden imports. The five focused CLI witnesses are Claude callback, monitor
approval context, monitor lifecycle, monitor recovery, and Session acceptance.

## Maintenance command facade

The renew, raw/managed cancel, observed-handoff close, generic managed close,
and orphan/lifecycle dispatch-close slice now lives in
`terminal-maintenance-cli-adapter.ts`. The adapter is a bounded CLI I/O shell;
it composes the existing terminal identity, acceptance, handoff, list, native
lifecycle, dispatch repository, and verified-dead recovery authorities rather
than copying a reducer, receipt, repository, or CAS transition. The subsequent
terminal monitor supervision facade owns monitor process supervision, monitor
reconciliation, and startup reconciliation. Maintenance routes its monitor
start and lock-version facts through that typed facade; ordinary delegate/send
presentation remains with its existing owner.

Against exact parent `8683b42c248b2310c59165ba712ecc943da3d775`,
`src/cli-core.ts` falls from 4,547 to 3,419 physical lines (-1,128). Total
production TypeScript changes from 91,535 to 91,961 lines (+426, 37.77 percent
of the core movement), meeting the preferred 450-line and hard 650-line
overhead gates. Architecture validation reports 54 domains, 116 production
modules, 742 static import edges, zero cycles, and one retained `cli-core.ts`
importer. The now 1,555-line adapter exposes only its factory at runtime and binds
four invocation-scoped port groups (`runtime`, `identity`, `authority`, and
`repository`) through async-local context. Its public option surface is
`Readonly<Record<string, unknown>>`; its source and declaration contain no
`any`, raw JSON codec, or resolved-terminal capability API.

Renew preserves selector/migration, status, verified-dead and uncertain-submit
fences before terminal availability, then reloads under its state lock,
revalidates binding and hard lifetime, persists state before the renewal event,
and launches/presents only after releasing state. Raw cancel takes terminal
then writer authority. Managed cancel preserves its distinct authorities:
the command-selected Store keys only the terminal lock, the state-file lock is
second, and the state-path-derived Store keys the writer lease third. It
releases writer -> state -> terminal. Its fresh Turn, terminal incarnation,
exact dispatch owner, bridge cancellation, event, state, and presentation order
is unchanged, and presentation stays inside the authenticated transaction.

Observed-handoff close retains terminal -> writer -> state, fresh Turn and
Session loads, native identity observation, exclusive target ownership, exact
handoff token and dispatch-generation validation, then Turn save -> ledger
resolve -> close event -> presentation. Generic close keeps its observed
handoff fence and verified-dead completion-first recovery, persists the closed
Turn before dispatch resolution and the append-only close event, and presents
only after those effects. Orphan/lifecycle dispatch close continues to
reconcile incarnation and deferred-transfer authority before lifecycle
recovery or exact message-id resolution. Possible terminal input is never
retried or downgraded.

Every extracted function remains below the hard 500/c50 gates. The cohesive
CLI-shell exceptions to the preferred 100/c20 target are:

| Function or nested transaction | LOC / approximate complexity |
| --- | ---: |
| `runClose` | 264 / c8 |
| generic close fresh-state transaction | 205 / c24 |
| `runRenew` | 192 / c32 |
| dispatch-close transaction | 184 / c22 |
| observed-handoff close transaction | 176 / c29 |
| `assertGenericCloseDoesNotBypassObservedHandoff` | 138 / c19 |

Direct recording tests prove concurrent factory isolation, factory-only
exports, typed declarations, raw-cancel reverse release, managed-cancel
terminal/state/writer order with distinct command/state Store keys, every
acquire/release error priority, and the getter/error/persistence tables for all
three commands. The five focused files are the maintenance facade, control
locks, monitor lifecycle, human-handoff adoption, and native lifecycle
recovery witnesses; together they retain real CLI cancel/close races, renew,
verified-dead completion, observed handoff, and exact lifecycle ledger
recovery.

## Terminal monitor supervision CLI facade

This slice moves 16 named monitor process-supervision functions spanning 706
physical function-span lines, plus the
`DEFAULT_MONITOR_POLL_INTERVAL_MS` constant, out of `cli-core.ts` into
`terminal-monitor-supervision-cli-adapter.ts`:
`spawnDetachedTerminalMonitor`,
`startTerminalBridgeMonitorForConversation`,
`ensureTerminalBridgeMonitorAfterApproval`, `runReconcileMonitors`,
`reconcileMonitors`, `latestTerminalBridgeMonitorLaunchPid`,
`prepareTerminalBridgeMonitorReconciliation`, `runMonitor`,
`startCallbackRetryMonitor`, `runCallbackRetryMonitor`,
`runTerminalBridgeMonitorHandoff`, `runTerminalBridgeMonitor`,
`runTerminalBridgeMonitorWithLock`, `activeTerminalBridgeMonitorOwner`,
`terminalBridgeMonitorLockOwner`, and
`tryAcquireTerminalBridgeMonitorLock`. The adapter owns only the detached
process shell, current/legacy process-owner supervision, watchdog retries,
singleton monitor locks, launch presentation, and CLI command routing. Monitor
state, acceptance, callback, deferred handoff, terminal-dispatch repository,
and terminal runtime behavior continue through their canonical facades and
services; no reducer or persistence protocol is copied.

Against exact parent `cc69f520207e276a4f3a55b0a32dfeb179ea8095`,
`src/cli-core.ts` falls from 3,419 to 2,735 physical lines (-684). Total
production TypeScript changes from 91,961 to 92,432 lines (+471), below the
hard 500-line overhead gate and below the moved core. Architecture validation
reports 54 domains, 117 production modules, 750 static import edges, zero
cycles, and one retained `cli-core.ts` importer. The adapter exposes only its
factory at runtime. Every function remains within the preferred limits; the
compiler-AST maximum is 59 physical lines and approximate c8.

The invocation-local boundary has exactly five port groups: `state`,
`callbacks`, `authority`, `io`, and `runtime`. `state` directly reuses
`terminalMonitorStateCliFacade` for service execution, deferral, collateral
repair, startup reconciliation, eligibility, and fresh launch preparation.
The callback-retry command branch delegates directly to `callbackCliFacade`
without acquiring a supervision lock. A normal callback reached through an
owned monitor retains its message-generation singleton owner, but the existing
callback/state adapters release state and writer locks before actual delivery.
`authority` performs legacy identity migration and constructs the terminal
bridge lazily.
`io` binds detached spawn, the existing file-lock adapter, Store reads/events,
and transcript reads. `runtime` supplies only invocation-scoped clock,
environment, workspace, process-liveness, logging, and presentation facts.
`loadTerminalDispatchLedgerOwner` and `assertManagedTerminalDispatchOwner`
remain with dispatch/maintenance composition and were not moved into monitor
supervision.

Startup reconciliation retains the durable observation order: collateral and
state-facade reconciliation first (local completion -> callback recovery ->
migration -> verified-dead -> deferred -> virgin -> binding -> eligibility),
then current owner before legacy owner, fresh launch preparation, detached
spawn, and only after successful spawn the exit/launch events, runtime log, and
counters. A failed or disabled spawn records no launch event. The approval path
also observes the exact generation owner, prepares the process plan, spawns,
and only then records reuse, watchdog, or launch presentation.

The watchdog acquires its generation-specific handoff lock and performs a
fresh Turn load on every retry; it never caches status, generation, owner, or
launch preparation across sleeps. The owned monitor acquires its
message-generation singleton lock before invoking
`runTerminalMonitorWithStoreDeferral` and releases it in `finally`. Supervision
directly classifies raw `LOCK_TIMEOUT` only while acquiring the handoff and
message-generation singleton process locks. State/application deferral
continues to classify typed Store timeouts and retains the existing raw
terminal/conversation timeout path. The monitor configuration and terminal
bridge remain lazy, so a replaced generation exits before timeout validation
or effect initialization. Live owners stop duplicate launch, and dead owners
are reclaimed by the canonical file-lock adapter. The monitor application
service is the sole emitter of the `terminal_bridge_monitor_started` event and
runtime log; command, receipt, and maintenance owners may still persist the
separate `terminal_bridge_monitor_started_at` state field.

Maintenance remains the owner of renew/cancel/close durable transitions. Renew
persists state and its renewal event under the state lock, releases that lock,
then calls the supervision facade's typed `startMonitor`; its persisted
`terminal_bridge_monitor_lock_version` now comes from the same facade. This
keeps the cross-module durable order state -> renewal event -> state-lock
release -> spawn -> launch event. Cancel and close lock stacks and their
dispatch authority are unchanged.

The old black-box paths now have direct invariant witnesses:

| Old behavior path | New direct invariant | Direct witness |
| --- | --- | --- |
| monitor plan, approval launch, and process isolation | entry/environment/cwd/spawn/unref order, secret stripping, current-owner reuse, spawn failure without an event, and parallel factory isolation | `terminal-monitor-supervision-cli-adapter.test.ts` |
| renew starts monitoring after its durable state transition | maintenance uses typed `startMonitor` and the supervision-owned lock version without changing renewal/cancel lock order | `terminal-maintenance-cli-adapter.test.ts` |
| startup state and collateral recovery precede process ownership | the existing state facade returns a data-only handled/candidate result before owner or launch observations | `terminal-monitor-state-reconciliation-service.test.ts` |
| monitor generation and Store contention | generation replacement precedes lazy configuration/bridge construction, while Store timeout deferral does not duplicate monitor start | `terminal-monitor-application-service.test.ts` |
| live/dead singleton ownership and startup restart | current and legacy owners stop duplicate launch, while the canonical lock shell reclaims an exact dead owner | `terminal-monitor-supervision-cli-adapter.test.ts` and `file-lock-cli-adapter.test.ts` |

The configured focused integration witnesses remain exactly five shards:
`test/shards/agent-cli-claude-callback.test.ts`,
`test/shards/agent-cli-monitor-approval-context.test.ts`,
`test/shards/agent-cli-monitor-lifecycle.test.ts`,
`test/shards/agent-cli-monitor-recovery.test.ts`, and
`test/shards/agent-cli-session-acceptance.test.ts`. They retain callback
delivery, approval, monitor lifecycle, singleton/restart recovery, and
Session-acceptance behavior through the real CLI boundary.

## Status CLI facade and data-only facts

The standalone status read, explicit status reconciliation, terminal context,
Codex history projection, managed Turn summary, discoverability fact, and idle
timeout reconciliation now live in `terminal-status-cli-adapter.ts` and
`terminal-status-facts.ts`. The CLI adapter is the bounded Store/runtime I/O
shell. The facts module is data-only and imports no filesystem/path API, Store,
Session repository, lock, raw JSON codec, or `Record<..., any>`. List,
terminal-command, identity, and runtime-completion composition use the same
exported fact or typed facade operation; no selector, terminal action, monitor,
or callback authority is copied.

Against exact parent `afa09955b0c5bd528aaaa69cf4d4f92ed1f44079`,
`src/cli-core.ts` falls from 2,735 to 2,122 physical lines (-613). This is the
bounded fallback slice: the remaining shared state/path selection and runtime
completion context stay at the composition root rather than absorbing
maintenance, transcript, or monitor supervision merely to increase movement.
Total production TypeScript changes from 92,432 to 92,904 lines (+472, 77.00
percent of the core movement), below the hard 500-line overhead cap though not
the preferred 300-line target. Architecture validation reports 55 domains, 119
production modules, 772 static import edges, zero cycles, and one retained
`cli-core.ts` importer.

The adapter exposes only its factory at runtime and has four invocation-scoped
port groups (`selection`, `observation`, `reconciliation`, and `projection`).
It directly reuses the invocation-local CLI clock/output/log and the existing
Store and trace infrastructure appropriate to a bounded CLI adapter. Default
`status` performs no writable-Store assertion, state lock, save, event append,
idle close, or monitor reconciliation. Only exact `--reconcile` first asserts
the Store writable, then calls the narrow monitor-reconciliation port, then
runs idle reconciliation and aggregates the two results.

Terminal-control status retains selector-token fencing before bridge status,
then historical context, JSON presentation, and the redacted runtime log.
Managed status retains events -> summary/about/recent evidence -> optional
trace -> terminal status ordering and its exact insertion order. Codex history
prefers the active process session id, otherwise sorts matching-cwd sessions by
descending update time, and finally reports screen-only evidence. Claude keeps
the adapter display name and explicit historical-context limitation. Public
options remain unknown-valued and the emitted declaration contains no `any` or
resolved capability object.

Idle reconciliation still observes the listed snapshot before acquiring the
state lock, skips nonterminal candidate-rollout source Turns, treats raw
`LOCK_TIMEOUT` as a skip, reloads the fresh Turn under lock, and rechecks fresh
idle age. A close remains save -> append-only event -> runtime log, with the
state lock released in `finally`. All 51 extracted function-like declarations
meet the preferred 100/c20 target: adapter maxima are 60 lines and c12; facts
maxima are 48 lines and c8. Direct tests cover concurrent factory isolation,
factory-only exports and declarations, zero-write default status, parent-exact
managed continuation and screen getter timing, non-Codex getter/error priority,
terminal and managed JSON order, newest-cwd Codex fallback and default bounds,
exact monitor aggregation, fresh idle locking/log getter order, and lock-timeout
skip. The five
focused CLI witnesses are CLI UX, management, control locks, monitor recovery,
and terminal-send gates.

## OpenClaw plugin boundary split

Against exact parent `96b5dbdf775ed55ef0efb9391ab2618167a08966`, the
2,830-line `openclaw-plugin.ts` monolith becomes a 67-line composition entry
(-2,763). The complete plugin family, including the unchanged 1,068-line
helper, moves from 3,898 to 3,974 lines (+76). Total production TypeScript
moves from 92,904 to 92,980 lines, so adapter overhead is 2.75 percent of the
entry movement and remains below both the preferred 250-line and hard 500-line
budgets. The graph moves from 119 to 123 production modules and from 772 to 783
static import edges, with zero cycles and the same sole `cli-core.ts` importer.
The affected ownership groups contain four OpenClaw plugin modules, two
callback-transport modules, and four monitor-supervision modules.

The split assigns one explicit role to every authority path:

- `openclaw-plugin-schemas.ts` owns the 14 tool JSON schemas and their exact
  property, `required`, `not`, `anyOf`, and `allOf` insertion order.
- `openclaw-plugin-command-adapter.ts` owns `/akk` parsing/formatting,
  registration and tool mapping, argv construction, synchronous/asynchronous
  CLI result/error priority, message identity, and the per-API relay-path
  `WeakMap`.
- `openclaw-plugin-callback-adapter.ts` owns callback identity and target
  agreement, automatic approval, injection, delivery planning, and shortcut
  text.
- `openclaw-plugin-supervisor.ts` owns startup reconciliation and the
  non-overlapping immediate/timer/start/stop monitor-supervision loop.
- `openclaw-plugin.ts` owns only `definePluginEntry` composition, stable plugin
  metadata, ordered registration wiring, the default export, and
  `createOpenClawPluginForTest`.
- `openclaw-plugin-helpers.ts` remains the canonical parser/formatter/store-dir
  helper owner; no helper was copied into a new module.

The static dependency graph is deliberately one-way:

```text
openclaw-plugin entry
  |-> callback adapter -> command adapter -> schemas -> executors
  |                    \-> helpers -> value guards
  |-> supervisor -------> command adapter
  |                    \-> helpers
  \-> command adapter ---> helpers
```

Neither callback nor supervisor is imported by command, schemas, or helpers,
and no split module imports the entry. The entry still binds the relay path
before registering the callback, then registers callback -> supervisor ->
slash command/tools in the original observable order. The merged status and
terminal-monitor-supervision facades remain unchanged and retain their newer
configuration, process ownership, and documentation authorities.

| Old monolith boundary | Preserved invariant | New authority and proof boundary |
| --- | --- | --- |
| 14 inline schema objects | byte-identical JSON, tool order, descriptions, required/exclusion semantics | schemas module; 12,657-byte schema SHA-256 contract and exact 14-tool registration witness |
| `/akk` plus tool registration/CLI execution | argv/env/cwd/stdout/stderr/exit/JSON/error and getter priority | command adapter; OpenClaw contract argv/result/error and Resume snapshot witnesses |
| callback gateway block | modern/legacy Session/Turn identity agreement, auto-approval, injection/delivery/shortcut order | callback adapter; callback injection, mismatch, approval, and per-API isolation witnesses |
| monitor reconciliation service | immediate startup, non-overlap, timer reschedule, stop/drain, catch-and-warn routing | supervisor module; recording supervisor timer witness |
| plugin factory and metadata | id/name/description, Gateway scope/error code, registration order, instance-local snapshots | 67-line entry; runtime and declaration expose only `default` and `createOpenClawPluginForTest` |

This is a source-ownership change only. It adds or removes no lock, Store or
durable JSON/event write, subprocess boundary, timer, Gateway method, or
Gateway restart. The existing `spawnSync`/`spawn` calls and their exact argv,
environment, working-directory, output, timeout, and error rules only moved to
the command adapter. At this exact plugin-split slice, static subprocess
startup evidence remained 38 included sites; that is a historical slice metric,
not the final result. The later static closeout establishes 19 of 48 baseline
sites. The single supervisor `setTimeout` loop only moved files, and no install
or restart path is called by plugin registration. Multiple plugin definitions
retain separate resume caches, while the existing per-API `WeakMap` keeps
relay path and plugin config isolated.

All newly extracted or moved slice functions remain below the hard
500-line/c50 gates. The unchanged canonical `openclaw-plugin-helpers.ts` is not
counted in this slice gate: its existing `parseAkkCommand` remains 188 lines/c58
and is retained for the final global complexity closure. The cohesive preferred
100-line/c20 exceptions in this slice are transparent and recorded below;
splitting the registration table or the ordered decision/format paths further
would obscure schema/action order or fail-closed precedence without reducing
authority.

| Function or table | LOC / approximate complexity |
| --- | ---: |
| `registerOpenClawCommands` | 398 / c1 |
| `runDelegate` | 178 / c45 |
| `handleAkkLifecycleCommand` | 165 / c30 |
| `runCliAsync` | 100 / c1 |
| callback `handleCallback` | 105 / c15 |
| `handleAkkCommand` | 90 / c22 |
| `formatSendCommandResult` | 84 / c28 |
| `formatStatusCommandResult` | 59 / c27 |
| `runSendRequest` | 93 / c21 |

The entry maximum is 37 lines/c3 and the supervisor maximum is 97 lines/c12.
Machine-readable public-contract evidence freezes the exact manifest plus six
source authority paths, checks a role-specific responsibility signature and
each required direct import, and rejects missing command/schema roles or an
existing but incorrect substitute path.

## #195 production function hard-gate closeout

PR #195 compares exact parent
`68e0e399152f5569ef0572b914da308acea36423` with exact candidate
`256614ede43188c7cf29594b5afe14331ff9b909`. The compiler-AST measurement
counts every production function, method, accessor, constructor, function
expression, and arrow function with a body, excluding nested function bodies
from the enclosing function's complexity.

| Metric | Parent | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Production physical LOC | 92,980 | 93,303 | +323 |
| Production functions | 4,019 | 4,044 | +25 |
| Largest function / maximum complexity | 834 / c190 | 484 / c49 | strictly below 500 / c50 |
| Hard-limit violations under the final rule | 6 | 0 | -6 |
| Production modules / import edges / cycles | 123 / 783 / 0 | 123 / 783 / 0 | unchanged |
| Static subprocess sites / affected full fallback | 19 of 48 / 2 of 10 | 19 of 48 / 2 of 10 | unchanged |

The six mechanical splits preserve evaluation, short-circuit, getter, and
first-error order:

| Parent hard violation | Parent LOC / complexity | Candidate private stages | Candidate stage maxima |
| --- | ---: | --- | ---: |
| `pendingApprovalFromRecords` | 237 / c50 | turn selection, tool-use agreement, evidence projection | 91 / c22 |
| `assertDeferredForegroundTransfer` | 834 / c190 | header, source history/binding, target, preparation, dispatch, commit, resolution, abort, failure | 142 / c37 |
| `deriveRelationshipAssertions` | 121 / c60 | Session relationships and stable relationships | 90 / c36 |
| `selectTerminalSnapshot` | 279 / c64 | row, process, management, and action selection | 128 / c28 |
| `assertNativeThreadTransition` | 327 / c71 | header, identity, receipt, and binding consistency | 146 / c29 |
| `parseAkkCommand` | 188 / c58 | lifecycle, Turn, and close parsing | 80 / c24 |

The gate is strict `<500` LOC and `<50` approximate complexity: a function
that reaches 500 or c50 fails. There is no exception field or allowlist. The
default `<100`/`<20` inventory remains visible for review but is not silently
treated as a hard failure. This closeout changes no module ownership or import
direction, lock scope or order, durable write or recovery phase, subprocess
boundary, public command/tool/schema/JSON contract, Store protocol, or runtime
export.

Exact-candidate validation covered typecheck, build, architecture, refactor
evidence, and diff checks; 186 relevant direct tests, 1,001 fast tests, and
five targeted integration files passed. Two independent exact-head reviews
returned GO. No full suite, install, package, publish, or GitHub Actions run was
part of PR #195.

## Final CLI-core facade and ownership closeout

The final closeout moves the remaining reusable authority and I/O helpers out
of `cli-core.ts` without moving another command state machine. CLI option
coercion and canonical workspace checks now live in `cli-command-runtime.ts`;
conversation activity/waiting policy lives in `protocol.ts`; callback process
failure classification lives in `callback-outbox-policy.ts`; and terminal
process liveness lives at the existing `ps` boundary in
`terminal-process-source.ts`. Terminal send safety is owned by
`terminal-authority-policy.ts`, OpenClaw yield presentation by
`terminal-dispatch-presenter.ts`, and Codex completion-context reads by the
status facade. List and monitor consumers reuse those canonical policies rather
than retaining private copies.

The Store-backed current-Turn fence is exposed through
`terminal-turn-binding-authority-cli-adapter.ts` under the existing terminal
identity-authority domain. It preserves Store selection, terminal-control
validation, writable-Store upgrade, protocol check, authoritative Session read,
and exact-or-migrated binding comparison order. Dispatch recovery now exposes
its existing ledger-owner read and managed-owner fence directly. Managed
approval/cancellation still checks deferred transfer, current binding, and the
ledger generation in that order; no lock, Store, error, or asynchronous
boundary is reordered.

Against exact parent `1274306e8e2f1e294910c8719b23de0d74878a31`,
`src/cli-core.ts` falls from 2,122 to 1,556 physical lines (-566). Total
production TypeScript changes from 93,303 to 93,313 lines (+10), the typed
owner/facade overhead for the final extraction. Architecture validation reports
57 domains, 125 production modules, 809 static import edges, zero cycles, and
one retained `cli-core.ts` importer. Its public surface remains the stable
`parseCliCommand` / `executeCliCommand` facade, and `CliCommandOptions` is now
`Record<string, unknown>` in both source and emitted declarations.

The final typed-boundary cleanup adds nine interface-only production lines to
remove the last `TerminalControlSendRequest` `Record<string, any>` bridge. The
closeout production ratchet is therefore 93,322 physical lines;
`cli-core.ts` remains 1,556 lines and the graph remains 125 modules, 809 edges,
and zero cycles. Direct source and emitted-declaration guards freeze the six
option properties and reject any reintroduction of raw `any` in the composition
boundary.

The ownership validator also fixes an independent Issue-level ceiling of 8,000
physical `cli-core.ts` lines. Manifest validation rejects a configured value
above 8,000, while architecture validation rejects an actual source above
8,000 even when a coordinated manifest edit makes the two values equal. The
exact ratchet remains 1,556; a direct tamper witness raises both source and
ratchet to 8,001, synchronizes the production total, and still fails on the
hard ceiling. The combined compiler-AST architecture gate reports zero
production function hard-limit violations. It also fixes one owner for each of
the six shared status predicates: conversation release, session-send blocking,
and callback supersede belong to `protocol.ts`; deferred-transfer finality
belongs to `deferred-foreground-transfer-policy.ts`; ordinary dispatch activity
and recovery belong to `terminal-dispatch-policy.ts`. The same compiler-AST
gate rejects duplicate predicate definitions, duplicate exact inline tables,
and full active/recoverable tables that bypass their derived policy.

An exact compiler-AST inventory ratchets the 27 remaining top-level functions
and rejects top-level classes or function-valued variables. A forbidden-owner
guard prevents terminal-send policy, Turn-binding authority, Codex context
loading, callback failure classification, process liveness, and status policy
definitions from returning to the composition root. Direct tests record the
Turn-generation and migrated compatibility boundary, superseded-error
projection, delegated/malformed short-circuits, deferred -> binding -> ledger
ordering and early failure, Codex provider/process/history read order, callback
classification priority, terminal-send getter/error priority, canonical
workspace behavior, and process/status policy reuse. Therefore `cli-core.ts`
contains no send, lifecycle, monitor, or callback state-machine definition; it
retains only stable parsing/execution, command routing, composition wiring,
shared lock scopes, and CLI parser/presentation compatibility.

## Integration virtual-clock profile remediation

The final profile remediation changes test timing only. Production timeout,
polling, retry, lock, and composer windows are unchanged. The ordinary
`runAgentCliInProcess` fixture also remains real-time by default. Selected
sequential scenarios opt in to `runAgentCliInProcessVirtual`, whose wall and
monotonic clocks are scoped by an explicit Store, state path, or
`AKK_RUNTIME_DIR`. Async sleeps advance that clock and yield one `setImmediate`
turn; sync sleeps only advance it. The fixture records both kinds of request,
reuses one monotonic clock across calls in the same fixture, and fails fast if
two commands try to share that clock concurrently.

The highest-volume sequential Codex cases may opt in one step further through
`runAgentCliInProcessDirect`. That helper still runs the production CLI parser,
composition, terminal adapters, identity fences, dispatch ledger, and receipt
state machines. It replaces only the executable fake `tmux`/`ps`/`lsof` ports
with the existing `MutableRecordingTerminalProvider` and
`StaticTerminalProcessSource`. `writeFakeTmux` and `writeFakeProcessTools`
register fixture-scoped panes, screens, and process snapshots; screen capture
remains live across calls, and direct text/key operations are projected into
the existing exact input ledger with a `direct_terminal_provider` marker.
Explicit JSON terminal fixtures retain their own static adapters. The direct
helper fails before command execution when it sees a capture/send/list gate,
delay, transport failure, uncertain SIGKILL outcome, or overlapping command.
It is additionally restricted to a non-empty Codex process fixture. Monitor,
Claude, empty-process, process-death, and executable-observation scenarios may
use virtual time where listed below, but never the direct provider seam.

The timing boundary is intentionally narrower than the test boundary:

| Virtual-time scenarios | Real-time boundary retained |
| --- | --- |
| Session follow-current/response generations and synthetic acceptance outcomes | v0.8.1 compatibility, Claude observation failure, the real native-binding window, and late-ACK child processes |
| Sequential dispatch recovery and receipt-fence state machines, using direct terminal/process ports where the executable shim is not the contract | the public active-managed dispatch witness, uncertain transport/SIGKILL recovery, and both concurrent-send witnesses |
| Wrapped-composer, prepared/orphan receipt, stable replay, and delegate replay semantics | the multilingual composer adapter witness and both gated raw-send process witnesses |
| Same-cwd/low-confidence monitor decisions, working hard-timeout policy, and sequential renew semantics | one complete Gateway callback path and the gated renew-versus-close race |
| Fake-process Claude death/transcript reconciliation | monitor singleton, live/dead PID and SIGKILL recovery, supervised/crash recovery, and transcript-monitor restart processes |
| Idle-gate matrix except injected capture failure, and managed background-conversation projection | capture failure, stale-PID, partial-`lsof`, raw approval, and direct cancel adapter witnesses |

No test name or pre-existing assertion is removed. Receipt bytes, whitespace,
error priority, no-second-Enter, no-terminal-input, and Store-authority
assertions remain in their original integration tests. The existing
`terminal-dispatch-ledger` public-contract mapping continues to pair those
retained receipt/recovery boundaries with the direct dispatch application,
ledger codec, receipt, and terminal-acceptance witnesses; no manifest path or
tier changes merely to claim a timing improvement.

Measure the focused worker cost from a clean exact commit with the repository
profile reporter. Run the identical command for the parent and candidate, on
the same host, Node version, compile-cache state, and concurrency:

```sh
test -z "$(git status --porcelain)"
npm run build
test -z "$(git status --porcelain)"
AKK_PROFILE_CACHE="$(mktemp -d /tmp/akk-126-integration-cache.XXXXXX)"
AKK_PROFILE_OUTPUT="/tmp/akk-126-integration-$(git rev-parse HEAD).json"
AKK_TEST_CONCURRENCY=4 \
NODE_COMPILE_CACHE="$AKK_PROFILE_CACHE" \
AKK_TEST_REPORTER="$PWD/scripts/test-profile-reporter.js" \
AKK_TEST_PROFILE_TIER=integration \
AKK_TEST_PROFILE_COMMIT="$(git rev-parse HEAD)" \
AKK_TEST_PROFILE_DIRTY=0 \
AKK_TEST_PROFILE_OUTPUT="$AKK_PROFILE_OUTPUT" \
node scripts/run-test-tier.js integration \
  test/shards/agent-cli-session-acceptance.test.ts \
  test/shards/agent-cli-dispatch-recovery.test.ts \
  test/shards/agent-cli-dispatch-authority.test.ts \
  test/shards/agent-cli-composer-replay.test.ts \
  test/shards/agent-cli-monitor-recovery.test.ts \
  test/shards/agent-cli-monitor-lifecycle.test.ts \
  test/shards/agent-cli-terminal-send-gates.test.ts \
  test/shards/agent-cli-receipt-fences.test.ts
```

Compare the sum of `files[].duration_ms`, not nested test durations, and reject
dirty, failed, wrong-SHA, wrong-Node, or wrong-concurrency reports. This section
does not claim the final performance gate: exact merged-head before/after
worker time and the repeated fast/full reports belong in the separate final
evidence update after all remediation branches are stacked.

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

## Issue #206 addendum — durable observation of human-started work

Issue #206 adds Terminal Watch as a new aggregate beside, not inside, the
managed Session/Turn architecture. The v16 action-contract and 14-tool sections
above remain immutable historical snapshots; the current public delta is list
action-contract v18 and 16 registered OpenClaw tools.

### Aggregate and persistence boundary

`TerminalWatch` schema v1 represents one task that a human started directly in
a Codex or Claude Code TUI. It is not a Conversation, Session, Turn, dispatch
receipt, monitor owner, or terminal-input authority. Creating or reconciling it
does not send input, adopt or claim the work, reserve the terminal, block later
human activity, or create callback authority for a managed Turn.

Each strict record contains `watch_id`, revision, agent, exact terminal endpoint,
workspace and internally resolved binding token; one privacy-safe provider anchor
owns the process incarnation, native thread/task and supported agent-version
evidence. The record also retains the originating OpenClaw session/binary,
creation/update/deadline timestamps, status, last activity, optional terminal
settlement, and an append-only notification outbox whose approval entries carry
their own evidence fingerprints.
Status is one of `active`, `completed`,
`failed`, `timed_out`, `invalidated`, or `cancelled`. The files live at
`<store>/terminal-watches/<watch_id>.json`, with a `0700` directory, `0600`
owner-private atomic JSON, strict path/symlink/shape validation, and revision
CAS. The independent namespace is admitted by the Store root allowlist without
changing Store format 1 or writer protocol 5.

Codex anchors retain the exact process identity, rollout device/inode/path, native
task, request hash, version, task-start/user-message/observed-end byte offsets,
capture time, and evidence fingerprint. Claude anchors retain the exact
process/session identity, workspace, transcript relative path/device/inode/file
identity, root prompt, request hash, version, current-turn/observed-end byte
offsets, capture time, and fingerprint. The compact terminal record separately
binds endpoint/incarnation, workspace, and the internal creation-time binding
token. The Store validates the provider-owned anchor directly, without a mirrored
Watch-specific shape or any raw prompt or command text.

### State, locking, and callback recovery

The user flow is human TUI start → fresh `/akk list` → copy only the advertised
`terminals[].available_actions.watch` action's exact `terminal_id` → create Watch
→ address it only by `watch_id` for status or unwatch. The creation path resolves
the current binding token internally, acquires the terminal lock, rescans and
revalidates the exact terminal incarnation and token, captures one unique
active-task anchor, then creates with expected revision `null`. All mutations acquire the canonical
Store writer lease before the per-Watch file lock. Observation occurs outside
that write scope; settlement reloads under `writer -> watch`, checks the exact
terminal and anchor fingerprints plus deadline, and commits one CAS transition.
Concurrent cancellation, timeout, settlement, or another observer therefore
cannot overwrite a newer revision.

The observation reducer yields `pending`, `approval`, `completed`, `failed`, or
`invalidated`. Any endpoint, process, native-thread/task, provider file,
offset/boundary, version/profile, request, or fingerprint drift—and any missing,
truncated, replaced, successor, unsupported, or ambiguous evidence—fails closed
as invalidated rather than following current terminal work. `unwatch` settles
only the aggregate as cancelled and never touches the TUI.

Approval appends one notification per exact fingerprint while leaving the Watch
active. It carries metadata only, never raw prompt/command text; Terminal Watch
has no approval execution port and cannot participate in automatic approval.
Completed/failed observations may retain only provider-redacted bounded
completion text (maximum 4,000 characters) plus optional completion identity and
timestamp. Every terminal outcome appends exactly one outcome notification.

Notification IDs derive deterministically from Watch, kind, and evidence
fingerprint; the transport idempotency key derives from Watch plus notification.
Delivery first persists a leased claim, performs transport outside the lock,
then CAS-settles success or retry metadata. A process crash leaves an expiring
claim that startup/periodic reconciliation can reclaim. This is crash-safe
at-least-once transport with effective at-most-once logical delivery when the
OpenClaw transport honors the idempotency key. One Watch's observation or
delivery failure is recorded in its reconciliation item and does not stop the
remaining Watches.

### Public wiring and supervision

The 16-tool OpenClaw surface adds `agent_knock_knock_watch` and
`agent_knock_knock_unwatch`; the existing status tool accepts exactly one of a
managed Turn target, semantic terminal target, or `watch_id`. List projects
active Watches in `terminal_watches[]` and advertises `watch` only for an exact,
supported terminal currently classified as working or awaiting approval. Slash
routing is `/akk watch <exact-terminal-id>`, `/akk status <watch-id>`, and
`/akk unwatch <watch-id>`. The internal CLI boundary has exactly four entries:

```text
watch-terminal --terminal <exact-terminal-id> ...
watch-status --watch <watch-id> ...
unwatch-terminal --watch <watch-id> ...
reconcile-watches ...
```

Action-contract v18 establishes a zero-token model boundary. Structured actions
carry semantic identities and user intent only:

- ordinary send is `{session_id, request}` for strict continuation or
  `{terminal_id, request}` for follow-current; the target fields are mutually
  exclusive and may both be absent only when AKK must prove one unique target;
- Terminal Watch is `{terminal_id}` only;
- native inspection is `{terminal_id, inspection}`, new is `{terminal_id}`, and
  resume is `{terminal_id, native_thread_id}`;
- managed approval is `{turn_id}`, terminal-scoped approval is `{terminal_id}`,
  reconcile is `{terminal_id, conflicting_session_id}`, and handoff takeover is
  `{turn_id, reason:"superseded_by_human_context_switch"}`.

Approval, reconcile, and handoff still require explicit user confirmation. The
trusted plugin/CLI retains that confirmation offer, derives fresh terminal,
binding, candidate, approval, handoff, revision, and compare-and-swap fences,
and revalidates them under the canonical locks immediately before mutation.
None of those opaque values—including live native UUIDs used only as a handoff
fence—crosses the model-facing boundary. Human slash selectors remain a CLI
discovery layer. Orphan close keeps `expected_message_id` and
`expected_transition_id` because they are durable entity identities rather than
authority tokens. This projection change does not alter Store format 1, writer
protocol 5, or the private persisted authority evidence.

The existing non-overlapping OpenClaw supervisor now coordinates two independent
steps at startup and every five seconds: managed-Turn monitor reconciliation and
Terminal Watch reconciliation. Each has its own error boundary, so a failure in
one cannot starve the other. Watch reconciliation observes active aggregates,
settles deadlines/outcomes, and drains eligible durable notifications; it does
not mutate Session/Turn state or replay terminal input.

The deterministic fast witnesses cover provider-anchor drift, Store privacy and
CAS, service restart/dedupe/timeout/claim-crash/retry behavior, callback
projection, list/action v18, slash/tool routing, and documentation. Per the
repository test policy, integration/full/release tests remain reserved for the
immediate pre-publication gate of an actual npm or ClawHub release.

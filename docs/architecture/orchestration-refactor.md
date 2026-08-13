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
| Transaction/lock kernel | Canonical lock acquisition/release; later, capabilities consumed by gated mutation ports | Business decisions, durable effect ordering, command parsing, or agent-specific screen logic |
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

The initial transaction shell only enforces canonical nesting and reverse
release for migrated call sites. It must not advertise a capability until a
persistence or terminal port actually requires and validates that token. Later
repository extraction should introduce per-transaction opaque capabilities at
those gated ports. Boolean parameters such as `terminalSendLockHeld`,
`terminalStateLockHeld`, and `storeWriterLeaseHeld` must not be reproduced in
new services.

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

### Initial transaction-shell write map

PR3 first applies the lock shell only to operations that already use the target
lock order. Their business callbacks remain in `cli-core.ts`; the shell does not
own these records or effects.

| Operation | Held lock scopes | Durable writes and existing order | Terminal input | Crash/retry direction |
| --- | --- | --- | --- | --- |
| `runReconcileBinding` | terminal -> writer | one managed Session CAS detach at the listed revision | definitely zero | before CAS, refresh and reauthorize; after CAS, detached is final and a stale token cannot retry |
| `runTerminalConversationCancel` | terminal -> writer | none; runtime audit and JSON output remain after the adapter call | possible ordered cancel keys | before input, a fresh cancel may retry; after an unacknowledged transport attempt, adapter semantics remain authoritative |
| `runObservedHandoffClose` | terminal -> writer -> state | Turn state `closed` -> exact dispatch-ledger resolution -> close event | definitely zero | advance only toward ledger/event reconciliation; stale handoff authority cannot start a second close |
| `runTerminalDispatchClose` | terminal -> writer | lifecycle reconciliation keeps its existing writes; orphan recovery writes one exact dispatch-ledger generation as `resolved` | definitely zero | advance only toward resolved; refresh is required after the recorded generation changes |

Each callback continues to perform the same observations, compare-before-write
checks, output, and error text under the same lock scopes. The transaction
module supplies no effect DSL and cannot construct Store or protocol state.

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

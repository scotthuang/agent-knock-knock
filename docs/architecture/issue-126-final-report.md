# Issue #126 architecture closeout report

Status: the product architecture and production-source freeze are complete.
Issue [#126](https://github.com/scotthuang/agent-knock-knock/issues/126)
was closed as completed on 2026-08-20. Exact-head operational evidence is the
remaining closeout step; four longitudinal measurements remain uncollected
follow-up observations and are not claimed as completed by this report.

This report is written against `main@61da2a6e482f96fb2b8d552fe4909d6e3ab09e64`.
The production freeze is
`49d351e8501efdb8814ba4d6646b8f7a81856cbc`: PRs #198 through #200 changed
tests, test infrastructure, configuration, and documentation only, so the
`src/**` tree at the report revision is byte-identical to that freeze.

This document does **not** claim that the final full-suite median is at or below
180 seconds, that the final dynamic subprocess comparison has passed, or that
the final local OpenClaw build has been installed. Those are separate
exact-SHA evidence steps described below.

## Product problem and outcome

At the v0.12.11 baseline, `src/cli-core.ts` owned 51.5 percent of production
TypeScript. It mixed parsing and presentation with terminal authority,
dispatch, lifecycle, callback, monitor, recovery, locks, and persistence. A
normal change therefore touched a shared 38,005-line integration point and
made ownership and durable-effect ordering difficult to review.

Issue #126 applied a strangler refactor, moving characterized behavior behind
typed policies, services, repositories, and adapters while preserving
`parseCliCommand` and `executeCliCommand`. Each vertical now has a named owner
and focused witnesses. Public CLI, OpenClaw, Session/Turn, Store, terminal, and
callback contracts remain compatible; the 1,556-line core is composition and
compatibility routing, not a second state-machine implementation.

## Before and after

The baseline is `ea592a88d7af4a709e7a7a1b989dd29e61932935`
(`v0.12.11`, measured 2026-08-14). The after column is the production freeze
carried unchanged by the report revision.

| Metric | Baseline | Production freeze | Result |
| --- | ---: | ---: | ---: |
| Production TypeScript LOC | 73,792 | 93,322 | +19,530 (+26.5%) typed ownership and adapters |
| Production modules | 38 | 125 | responsibilities split into reviewable owners |
| `cli-core.ts` LOC | 38,005 | 1,556 | -36,449 (-95.9%) |
| `cli-core.ts` share of production | 51.5% | 1.7% | -49.8 percentage points |
| Production functions at or above 500 LOC | 9 | 0 | strict `<500` hard gate |
| Maximum production function LOC / approximate complexity | 1,886 / c302 | separate maxima of 484 LOC and c49 at hard-gate closeout | strict `<500` / `<50`, no allowlist |
| Production import cycles | 0 | 0 | acyclic throughout |
| `openclaw-plugin.ts` entry LOC | 2,830 before its split | 67 | -2,763 (-97.6%) |
| Included product-test subprocess sites | 48 | 19 | -60.42% static closeout |
| Frozen affected-selector replay | — | 8 targeted / 2 full | 80% avoid full fallback; point evidence only |

The production LOC increase is visible typed ownership, not generated code or
generic bags. Exact manifest ratchets prevent the core or total from silently
growing.

## Canonical vertical ownership

A CLI adapter may translate options, acquire its shell capabilities, call one
use case, and present the result; it may not recreate the use case's decisions.

| Vertical | Unique canonical authority | I/O and durable boundary | CLI/OpenClaw role |
| --- | --- | --- | --- |
| Terminal identity, binding, and actions | terminal binding/identity authority, terminal authority policy, and terminal action projection | terminal/process observations plus authoritative Session reads | list, status, send, approve, cancel, and lifecycle adapters consume the same decision facts |
| Dispatch and acceptance | terminal dispatch policy/application, submission acceptance, receipt, ledger codec, repository, and recovery | exact terminal input, prepared/accepted receipt writes, ledger CAS and recovery | terminal command facade maps command options and presents the canonical result |
| Native lifecycle | native-thread transition policy, application, settlement, verification, lifecycle query, and lifecycle CLI adapter | transition records, terminal observation/input, Session CAS, and recovery | New/Clear/Resume/inspect commands route to one lifecycle composition |
| Deferred foreground handoff | deferred-foreground policy, preparation/application services, capability repositories, and authority adapter | append-only transfer/receipt history and terminal -> writer -> state transactions | ordinary send and recovery call the same handoff authority instead of copying it |
| Callback and outbox | callback outbox policy, service, settlement, OpenClaw callback transport, and callback facade | immutable message/attempt state, Gateway process transport, retry ownership, and settlement events | callback/retry commands and monitors share one outbox implementation |
| Monitor and reconciliation | monitor decision policy/application, state reconciliation, and supervision facade | polling observations, singleton process ownership, state/event writes, and callback preparation | monitor commands and OpenClaw supervision schedule the same services |
| List, status, delegate, and maintenance | dedicated list, status-facts/status, delegate, and maintenance facades | bounded Store/terminal reads and explicit reconciliation-only mutations | default reads remain read-only; formatting does not grant mutation authority |
| Persistence and locking | Store and Session repositories/codecs, durable JSON and dispatch-ledger I/O, mutation capabilities, and file-lock adapter | no-follow/atomic write, fsync/rename, revision/CAS, writer and state locks | services receive typed capabilities rather than raw paths or `*LockHeld` booleans |
| Runtime and external adapters | async-local CLI runtime, tmux/Herdr providers, Codex/Claude adapters, OpenClaw Gateway adapter | process argv/env/cwd/timeout/exit, terminal screen/input, clocks and sleeps | entrypoints bind ports; policies do not import process or filesystem APIs |

Six formerly duplicated status decisions are also frozen to a single source.
Conversation release, Session-send blocking, and callback supersession belong
to `protocol.ts`; deferred-transfer finality belongs to
`deferred-foreground-transfer-policy.ts`; ordinary dispatch activity and
recoverability belong to `terminal-dispatch-policy.ts`. Compiler-AST guards
reject duplicate function definitions, copied exact tables, and bypass tables
in other owners.

## Service, CLI, and dependency boundaries

Dependencies flow from CLI/OpenClaw entrypoints through typed composition,
use cases, pure policies, and domain ports. Filesystem, Store, tmux, Herdr,
Codex, Claude, and Gateway adapters implement those inward-facing ports.

`src/cli.ts` is the sole production importer of `cli-core.ts`. The core keeps
stable parser/executor exports, routing, composition, shared scopes, and
compatibility presentation; it contains no send, lifecycle, monitor, or
callback state machine. Its options are `Record<string, unknown>`, guarded in
source and declarations against a returning raw-`any` bridge.

Pure decisions import no filesystem, process, environment, clock, or sleep
APIs. Services use typed ports; CLI adapters own option/path translation and
transaction shells; infrastructure owns external semantics. Validation reports
57 domains, 125 modules, 809 edges, zero cycles, and one core importer. Known
domains select at most five focused integration witnesses; shared authorities
still fail closed to the full tier.

## OpenClaw boundary

The OpenClaw entry is no longer a second orchestration monolith. Schemas owns
the exact 14 tools; command adapter owns `/akk`, tool mapping and CLI process
projection; callback adapter owns identity, approval, injection and delivery;
supervisor owns non-overlapping monitor scheduling; helpers remains the shared
parser/formatter owner; the 67-line entry owns metadata and ordered composition.

The plugin family grew by 76 lines while its entry lost 2,763. The split added
or removed no lock, durable write, process, timer, Gateway method, restart, or
public tool contract. Exact schemas, tool order, callback identity, registration
order, instance isolation, and supervision remain contract witnesses.

## Compatibility, locking, and persistence invariants

The refactor retains Store format 1, writer protocol 5, Session-authority
protocol 3, managed Session schema/version 1, native-transition schema/version
1, and readable deferred-foreground v1/v2. It also retains package/executable/
plugin identities, `/akk`, 14 tools, CLI/public JSON/redaction/legacy decoding,
and Codex/Claude plus tmux/Herdr identity, cwd, incarnation, and composer fences.

The canonical mutation order remains:

```text
terminal dispatch lock -> Store writer lease -> conversation state lock
```

Capabilities are invocation-local, resource-bound, and invalidated before
reverse-order lock release. A valid capability cannot be paired with another
terminal, Store, state path, or transaction. Durable effects retain their
original order: prepare before terminal input, text before exactly one Enter,
Enter before native acceptance, and state before append-only event where the
existing protocol requires it. Possible input, uncertain dispatch, uncertain
approval, and uncertain lifecycle outcomes are never blindly retried.

Callback preparation and state claiming remain inside their required writer
and state boundaries; Gateway delivery occurs after the outer locks release.
Callback progress, success, failure, retry scheduling, and accepted-transport
recovery remain the responsibility of the canonical outbox settlement path.
Lifecycle and deferred-transfer recovery retain their CAS and crash boundaries.
Ledger and durable-file adapters retain no-follow opens, temporary writes,
fsync, rename, directory fsync, and cleanup behavior.

## Enforceable evidence at the production freeze

The architecture closeout is guarded by checked-in machine-readable evidence,
not only by this narrative:

- exact ownership ratchets: 1,556 `cli-core.ts` lines and 93,322 production
  lines;
- a separate hard ceiling of 8,000 core lines that cannot be bypassed by
  editing the ratchet to 8,001;
- zero production functions reaching 500 LOC or c50, with no exception or
  allowlist;
- 57 domains, 125 modules, 809 edges, zero cycles, and the sole permitted core
  importer;
- 19 of the immutable 48 included product-test subprocess sites, a 60.42%
  static reduction, while crash, lock, PID/SIGKILL, Gateway, terminal adapter,
  and argv/exit witnesses remain process-backed;
- a frozen ten-change affected-selector replay with eight targeted and two
  full results; unknown/shared authority still selects full;
- four public contracts, 65 witnesses, 11 migration mappings, the exact 14
  OpenClaw tools, and five Store protocol witnesses;
- compiler-AST guards for canonical status ownership, top-level core inventory,
  forbidden owner returns, declarations, and dependency direction.

The post-freeze test work preserves rather than weakens those contracts. PR
#198 batches repeated Git metadata reads and replaces selected wall waits with
real completion gates. PR #199 expands the canonical 97-test no-rollout file
into eight worker-isolated shards while preserving the canonical manifest
entry, test names, assertions, affected selection, and dynamic-evidence source
identity. PR #200 adds explicitly scoped virtual clocks and direct recording
terminal/process ports only for sequential deterministic fixtures; real timing,
process death, concurrency, Gateway, SIGKILL, and terminal-input canaries remain.
These facts describe test architecture, not final exact-head performance.

## Merged delivery stages

Issue #126 was merged incrementally so each authority and durable boundary
could be reviewed independently:

| PR stage | Merged PRs | Main result |
| --- | --- | --- |
| Baseline, safety characterization, and transaction foundations | #134-#148 | architecture/evidence baseline, action and binding authority, verified-dead policy, capability repositories, durable JSON/ledger codecs, approval and zero-input safety |
| Test-loop seams and bounded infrastructure extraction | #149-#162 | in-process command seam with retained real boundaries, installer/doctor adapters, atomic ledger I/O, lifecycle reconciliation, acceptance and runtime evidence |
| Vertical application services | #163-#174 | callback preparation, monitor decisions/application/reconciliation, dispatch application, lifecycle query/mutation/recovery, authority projection, deferred foreground recovery, dynamic subprocess evidence |
| Typed CLI and repository facades | #175-#186 | list/file-lock/terminal-command facades, dispatch repository/recovery, runtime providers, acceptance, identity, prerequisites, lifecycle, deferred handoff, callback, and native transition composition |
| Secondary facade and OpenClaw closeout | #187-#192 | delegate, monitor state, maintenance, monitor supervision, status facts/facade, and OpenClaw plugin split |
| Enforceable architecture closure | #193-#197 | affected-selector gate, 60% static subprocess gate, zero-allowlist function gate, 1,556-line final core, typed-boundary/docs freeze |
| Merged test-only performance remediation | #198-#200 | fast fixture cleanup, canonical no-rollout sharding, and scoped integration virtual-clock/direct-provider fixtures |

The production source freeze is the result of #197. The last row is deliberately
outside production ownership: the diff from #197 through #200 contains no
`src/**` path.

Two additional performance experiments are **not merged** and are not part of
the production freeze or acceptance evidence:

- `refactor/126-control-stale-direct@3ffa179312888ad7db97fdb74bb1001bd53beaef`;
- the `refactor/126-callback-transport-profile` callback experiment.

Results or local edits from either branch must not be quoted as main-branch
behavior, included in final metrics, or installed into OpenClaw.

## Pending exact-SHA validation and installation evidence

The final point-in-time evidence will be recorded in an Issue #126 comment tied
to one exact clean SHA. That comment, rather than this architecture report,
will carry:

- fast, integration, and full profiles each run three times from the same final
  clean SHA on the same host with Node 24.18.0, concurrency four, and one shared
  warm cache, together with their raw reports;
- the final full-suite median comparison, without changing production timing
  windows or default concurrency;
- the dynamic subprocess attestation from one clean baseline full run and one
  clean current full run, together with its retained real-process boundaries;
- the exactly-once local OpenClaw install command and installer verification;
- installed source, runtime, manifest, and skill hashes matched to the exact
  repository SHA;
- exactly one Gateway restart, readiness and smoke results, plus confirmation
  that the protected user development process was not touched.

Until that comment exists and its reports pass, this report makes no statement
that the full tier is at or below 180 seconds and no statement that installation
has completed.

## Longitudinal measurements remain uncollected

Issue #126 is already closed for the implementation refactor and will not be
reopened by this closeout. Real post-refactor history has not yet established
the four longitudinal measurements originally listed in the issue:

1. at least 70% of normal product changes avoid `cli-core.ts`;
2. at least 80% of normal affected-test loops finish within 60 seconds;
3. five post-refactor product changes reduce median ready-to-release lead time
   by at least 40%; and
4. repeated full-suite flaky failures remain below 1%.

The ten-change selector replay and any one exact-head profile are useful point
evidence, but neither substitutes for these samples. The final closeout freezes
the implementation and records these measurements as follow-up observations;
it does not claim that they have been achieved.

For the detailed extraction chronology and measurement definitions, see
[orchestration-refactor.md](./orchestration-refactor.md) and
[orchestration-baseline.json](./orchestration-baseline.json).

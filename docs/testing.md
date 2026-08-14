# Testing

Agent Knock Knock keeps every deterministic, integration, compatibility, and
regression test, but it does not charge the full process-heavy suite to every
edit. The canonical classification is `test/test-tiers.json`. A manifest test
and every tier runner fail before execution if a test file is missing,
duplicated, or unclassified.

## Test tiers

| Command | Purpose | When to run |
| --- | --- | --- |
| `npm run test:fast` | Deterministic unit/component tests without test-level child processes | Every development loop |
| `npm run test:integration` | CLI subprocess, monitor, SQLite, Store locking, lifecycle, installer, and compatibility fixtures | For the changed subsystem |
| `npm run test:affected` | Complete fast tier plus mapped integration tests; unknown or shared-core changes run the full tier | Local branch and worktree feedback |
| `npm run test:full` | The exact union of fast and integration tests | Before every PR merge and release |
| `npm test` | Compatibility alias for `test:full` | Existing automation and maintainer habits |
| `npm run test:release` | Full suite, isolated OpenClaw compatibility matrix, ClawHub runtime validation, and ClawHub publish dry-run | Release-relevant changes |
| `npm run test:release:live` | The release tier plus credentialed native Codex and Claude lifecycle smoke/attestation | Only with dedicated prepared tmux panes |

The live release tier can make authenticated coding-agent turns. It is never
selected by `npm test` or `test:release`; opting in is an explicit operational
decision. The ordinary release tier builds in temporary state and does not
control a real coding-agent pane.

The live gate requires both complete panes, a new private evidence path outside
the repository, the environment opt-in, and the command-line confirmation. It
forwards the exact arguments to the single-attempt lifecycle runner and then
verifies the resulting Codex+Claude matrix evidence:

```bash
AKK_RUN_LIVE_LIFECYCLE_SMOKE=1 npm run test:release:live -- \
  --confirm-live \
  --codex-target <session:window.pane> \
  --codex-expected-pane-pid <pid> \
  --codex-expected-version <version> \
  --claude-target <session:window.pane> \
  --claude-expected-pane-pid <pid> \
  --claude-expected-version <version> \
  --evidence </absolute/private/new-evidence.json>
```

The runner builds once per tier and passes an explicit cross-platform file list
to Node instead of relying on shell glob behavior. Its default file concurrency
is capped at four because each integration worker recursively starts CLI and fake
terminal processes; higher values made both wall time and bounded test-fixture
timeouts worse on the maintainer machine. Override it with
`AKK_TEST_CONCURRENCY` for a controlled benchmark. The runner also gives Node
child processes a shared bytecode cache under the operating-system temporary
directory. Override `NODE_COMPILE_CACHE` when profiling a particular cache, or
point it at a new `mktemp -d` directory for a cold-cache comparison.

## Affected tests

`test:affected` builds once, reads changed and untracked paths without shell
globs, and always runs the complete fast tier. By default it compares `HEAD`
with the current index and worktree. Supply an explicit base to include branch
commits as well as staged, unstaged, and untracked changes:

```bash
npm run test:affected
npm run test:affected -- --base origin/main
```

Known source subsystems map to exact integration-tier manifest entries. A
changed integration test selects itself, while a changed fast test or
documentation file needs no additional integration worker. Selection is
fail-closed: an unreadable Git diff, a stale mapping, an unknown path, or a
shared CLI dispatch, Store/protocol, terminal-identity, or lifecycle-safety
path selects `test:full`.

This command narrows local feedback only. It does not replace `npm test` for a
merge, release, or final verification.

## Targeted integration map

Always run `test:fast` first. Then select the integration files below; paths are
source paths under `test/` and the tier runner handles their compiled `dist`
paths.

Pass one or more exact manifest paths after `--` to run only those integration
files. The runner rejects duplicates, unknown paths, and files from the fast
tier, so a typo cannot silently weaken the intended check:

```bash
npm run test:integration -- \
  test/codex-store-adapter.test.ts \
  test/stale-bound-resume-cli.test.ts
```

| Changed subsystem | Targeted integration files |
| --- | --- |
| CLI parser, help, version, doctor, redaction | `test/cli-ux.test.ts` |
| Raw/managed send, composer/Enter, acceptance and receipt fences | `test/shards/agent-cli-terminal-send-gates.test.ts`, `test/shards/agent-cli-composer-replay.test.ts`, `test/shards/agent-cli-session-acceptance.test.ts`, `test/shards/agent-cli-receipt-fences.test.ts`; add `test/codex-no-rollout-binding-cli.test.ts` for virgin attachment |
| Dispatch authorization, locks, retry and recovery | `test/shards/agent-cli-dispatch-authority.test.ts`, `test/shards/agent-cli-control-locks.test.ts`, `test/shards/agent-cli-dispatch-recovery.test.ts`, `test/shards/agent-cli-receipt-fences.test.ts` |
| Callback outbox, responder, retry, Gateway wake and close races | `test/callback-cli.test.ts`, `test/openclaw-plugin-contract.test.ts`, `test/shards/agent-cli-claude-callback.test.ts`, `test/shards/agent-cli-monitor-lifecycle.test.ts`, `test/shards/agent-cli-monitor-recovery.test.ts` |
| Monitor completion, approval context, cancellation and renewal | `test/shards/agent-cli-monitor-lifecycle.test.ts`, `test/shards/agent-cli-monitor-recovery.test.ts`, `test/shards/agent-cli-monitor-approval-context.test.ts`, `test/shards/agent-cli-control-locks.test.ts` |
| Delegate, workspace and terminal selection | `test/delegate-cli.test.ts`, `test/session-selector-cli.test.ts`, `test/management-cli.test.ts` |
| List, status, available actions and terminal discovery | `test/management-cli.test.ts`, `test/session-selector-cli.test.ts`; add `test/codex-no-rollout-binding-cli.test.ts` for binding conflicts |
| Codex SQLite/state DB, rollout fd, WAL, candidate discovery and version filtering | `test/codex-store-adapter.test.ts`, `test/codex-no-rollout-binding-cli.test.ts`, `test/stale-bound-resume-cli.test.ts` |
| Virgin attach, reconcile-binding, PID incarnation/reuse and orphan recovery | `test/codex-no-rollout-binding-cli.test.ts`, `test/native-thread-ownership-cli.test.ts`, `test/stale-bound-resume-cli.test.ts`, `test/turn-session-binding-cli.test.ts`, `test/shards/agent-cli-dispatch-recovery.test.ts` |
| Native New/Clear/Resume transitions and guards | `test/native-thread-lifecycle-cli.test.ts`, `test/native-thread-lifecycle-recovery-cli.test.ts`, `test/native-thread-ownership-cli.test.ts`, `test/native-lifecycle-command-guard-cli.test.ts`, `test/codex-sticky-rollout-lifecycle-cli.test.ts`, `test/stale-bound-resume-cli.test.ts`, `test/codex-no-rollout-binding-cli.test.ts` |
| Store, Session, Turn, writer protocol, migration and locks | `test/store.test.ts`, `test/store-protocol-cli.test.ts`, `test/turn-session-binding-cli.test.ts`; add `test/session-selector-cli.test.ts` for projections |
| OpenClaw tool schemas, slash routing, supervisor and manifest | `test/openclaw-plugin-contract.test.ts`, `test/management-cli.test.ts`; add `test/install-openclaw-cli.test.ts` for installation/skill sync |
| Installer trust, force, update and restart readiness | `test/install-openclaw-cli.test.ts` |
| Runtime logs, redaction and permissions | `test/runtime-log.test.ts` |
| Lifecycle evidence, verifier and release guards | `test/live-lifecycle-verifier.test.ts`, `test/live-smoke-guards.test.ts` |
| Compatibility or legacy identifiers/protocols | The exact domain file plus `test/store.test.ts`, `test/store-protocol-cli.test.ts`, `test/turn-session-binding-cli.test.ts`, or `test/session-selector-cli.test.ts` as applicable |

The 11 former `agent-cli.test.ts` domains map one-to-one to exact integration
manifest entries; use these names directly rather than a shell wildcard:

| Agent CLI domain | Exact manifest path |
| --- | --- |
| Claude callback and response delivery | `test/shards/agent-cli-claude-callback.test.ts` |
| Composer replay and paste-window submission | `test/shards/agent-cli-composer-replay.test.ts` |
| Terminal mutation and dispatch locks | `test/shards/agent-cli-control-locks.test.ts` |
| Dispatch ownership and authorization | `test/shards/agent-cli-dispatch-authority.test.ts` |
| Interrupted dispatch recovery | `test/shards/agent-cli-dispatch-recovery.test.ts` |
| Monitor approval context | `test/shards/agent-cli-monitor-approval-context.test.ts` |
| Monitor completion lifecycle | `test/shards/agent-cli-monitor-lifecycle.test.ts` |
| Monitor/callback recovery | `test/shards/agent-cli-monitor-recovery.test.ts` |
| Acceptance and delivery receipt fences | `test/shards/agent-cli-receipt-fences.test.ts` |
| Session/Turn acceptance and bookkeeping | `test/shards/agent-cli-session-acceptance.test.ts` |
| Raw and managed terminal send gates | `test/shards/agent-cli-terminal-send-gates.test.ts` |

The mapping narrows feedback; it does not replace the full-suite requirement.
Safety fences from #87, native lifecycle smoke tooling from #88, Store upgrade
paths, Codex 0.146.0/0.146.1/0.147.0, OpenClaw boundaries, and verified Claude schemas
remain covered.

## Profiling

Run the same tier, Node version, concurrency, machine, and compile-cache mode
before and after a performance change:

```bash
npm run test:profile -- --output /tmp/akk-test-profile.json
npm run test:profile -- integration --output /tmp/akk-integration-profile.json
```

The reporter records the commit and dirty state, Node/platform/CPU metadata,
concurrency and cache path, total wall duration, counts, per-file worker
duration, and every test duration. It prints the 20 slowest files and tests and
writes the complete JSON report when `--output` is supplied. Set an explicit
concurrency for a controlled comparison:

```bash
AKK_TEST_CONCURRENCY=8 npm run test:profile -- --output /tmp/akk-profile-c8.json
```

Do not reduce production polling/settle windows, disable process isolation, or
force-exit the runner to improve a benchmark. Split independent file workers,
inject clocks/providers where semantics permit it, and retain thin real-process
coverage for process, WAL/checkpoint, fs-lock, and lifecycle boundaries.

## #126 callback in-process migration

Eight once-per-file executable starts in `test/callback-cli.test.ts` now use the
same `parseCliCommand` to `executeCliCommand` path imported by the executable.
Their original assertions remain in place. The migration maps each former
black-box case to the service invariant it exercises and the process boundary
that remains black-box:

| Former executable case | Imported service invariant | Retained real boundary |
| --- | --- | --- |
| Late callback after Turn release | Reject before state or event mutation | Emitted callback argv/stdout/exit goldens |
| Corrupted event log | Fail closed on Store validation | Emitted callback error projection |
| Failed question notification | Preserve `waiting_for_openclaw` and failed outbox state | Fake OpenClaw Gateway child failure |
| Close after failed delivery | Keep the failed outbox retryable and immutable | Gateway child plus separate executable concurrency witnesses |
| Reused message ID with changed payload | Reject payload mutation under an existing claim | Retained callback executable helper |
| Explicit Gateway URL/token retry | Persist authentication while redacting public state | Fake OpenClaw environment and argv |
| Automatic transient retry | Preserve retry state and monitor scheduling | Real retry-monitor and Gateway children |
| Manual retry during automatic attempt | Report the exact live lease without mutation | Concurrent winner/loser CLI processes |

The dynamic callback test path therefore starts eight fewer CLI processes. The
reproducible static evidence moves from 48 to 40 included startup sites
(`cli_process` 38 to 30), while all 10 fake-Node startup sites remain. The
machine-readable `callback-outbox` migration in
`config/public-contract-witnesses.json` ties the old executable witnesses to
the callback policy, settlement, and transport service invariants and to the
retained CLI, Claude, and OpenClaw boundaries.

## #126 CLI UX and native-ownership in-process migration

The second migration slice routes 21 normal invocations through
`parseCliCommand` and `executeCliCommand`: eight help, version, doctor, and
redaction invocations plus thirteen native-ownership sends. The test and
assertion inventories are unchanged.

| Former executable cases | Imported service invariant | Retained real boundary |
| --- | --- | --- |
| Help and version aliases | Exact parser aliases, stdout bytes, and success status | CLI import isolation and copied-distribution doctor executable |
| Runnable-doctor failure and public redaction | Probe result projection and secret-free JSON | Copied-distribution doctor argv/stdout/OS-exit plus real-CLI runtime-log redaction |
| Codex and Claude native ownership sends | Exact PID/UUID, Store, binding-generation, and stale-ledger authority | Codex attach, handoff, lifecycle recovery, and terminal-send executable suites |

The static metric removes the two direct native-ownership startup sites and the
shared normal CLI UX startup site, moving the current evidence from 40 to 37
included sites (`cli_process` 30 to 27). All fake-Node sites remain. Claude
native inspection was also audited, but remains executable-backed because its
PATH-scoped `ps` and `tmux` discovery is not equivalent through the current
in-process dependency seam. Crash injection, OS exit, process competition,
file-lock, monitor-PID, nested Gateway approval, updater, and terminal-process
witnesses in `agent-cli-fixtures.ts` remain process-backed.

The machine-readable `cli-runtime` and `terminal-binding-authority` mappings in
`config/public-contract-witnesses.json` connect the migrated cases to focused
service invariants and retained executable witnesses.

### Doctor capability boundary tier

Doctor capability evaluation and invalid-timeout policy remain in the fast
tier. The four tests that intentionally execute fake Node and shell programs
live in `test/doctor-capabilities-process.test.ts` in the integration tier.
They still prove exact argv, version parsing, executable permissions, timeout,
non-zero exit, missing executable, and malformed-output behavior; only their
tier classification changed.

## #126 management, selector, and Session-binding in-process migration

The third migration slice removes the outer CLI process from 50 normal command
invocation expressions across 24 tests while preserving all 298 assertion call
sites. `management-cli` and `session-selector-cli` now exercise the executable's
same `parseCliCommand` to `executeCliCommand` path for list, status, selector,
static-terminal, and synthetic-acceptance behavior. The six record-only
`turn-session-binding-cli` callbacks use that path for Session authority checks.

| Former executable cases | Imported service invariant | Retained real boundary |
| --- | --- | --- |
| Ten management list/status invocations | Exact JSON projection, trace redaction, static terminal observation, and action-contract v16 | Standalone executable list/status in `store-protocol-cli`, copied-distribution CLI output/exit |
| Thirty-four selector, status, send, respond, and approve invocations | Deterministic ambiguity failures, canonical ownership, cross-Store fencing, and exact selector/token routing | Codex binding and terminal-send executable suites with real terminal observation/input |
| Six record-only callback binding invocations | Protocol-3 Session presence, generation, process evidence, route-rename, and protocol-2 compatibility | Callback executable argv/exit, Gateway, retry, and concurrency suites |

The static metric removes one CLI startup site from each migrated file, moving
the evidence from 37 to 34 included sites (`cli_process` 27 to 24). All 10
fake-Node sites remain. Writer-protocol mismatch and fake-tmux observation in
`store-protocol-cli`, callback Gateway/concurrency, Store crash and migration,
terminal input, lock competition, monitor PID, and OS-exit witnesses remain
process-backed.

The machine-readable `callback-outbox`, `terminal-binding-authority`, and
`terminal-list-renderer` mappings tie each former executable family to its fast
service invariant and to a separate retained real-process witness.

## #126 deterministic dispatch-admission in-process migration

The fourth migration slice removes 27 outer CLI process starts across 23 tests
while preserving all 63 assertion call sites in those cases. The commands still
enter through `parseCliCommand` and `executeCliCommand`; only the redundant Node
executable boundary is removed.

| Former executable cases | Imported service invariant | Retained real boundary |
| --- | --- | --- |
| Ten delegate routing tests (14 invocations) | Deterministic agent, workspace, pane-incarnation, and exact-selector routing over the production static terminal/process adapters | Dispatch-authority, recovery, and terminal-send executable suites |
| Twelve native slash-command guard cases | Every ordinary send/respond alias rejects before Store creation or terminal input | Native lifecycle and lifecycle-recovery crash/terminal executables |
| One static-fixture acceptance case | Synthetic transport cannot become native acceptance without the explicit opt-in | Session-acceptance, receipt-fence, and terminal-send executable suites |

The delegate fixture continues to use the production
`StaticTerminalProcessSource` selected by `--processes-json`. Its former fake
`ps` executable supplied only a deterministic Codex process-birth string and
was not a PATH-discovery assertion, so the imported command now injects that
same typed observation directly. PATH-scoped process discovery remains covered
by its dedicated executable tests. Environment, cwd, clock, output, and exit
state are scoped through the CLI async-local runtime; no test mutates process
globals.

The static metric removes one CLI startup site from each migrated file, moving
the evidence from 34 to 31 included sites (`cli_process` 24 to 21). All 10
fake-Node sites remain. Test tiers are unchanged: these filesystem and terminal
component cases remain in the integration tier even though their redundant
outer executable was removed.

The machine-readable `terminal-dispatch-policy` and
`terminal-dispatch-ledger` mappings connect the imported cases to focused
policy/acceptance invariants and to retained real-process witnesses for argv,
OS exit, terminal input, crash recovery, locks, concurrency, monitor PID,
Gateway transport, and Store writer fencing.

## #126 callback normal-command in-process migration

The fifth migration slice routes all 20 successful invocations that formerly
shared the generic synchronous callback CLI helper through `runInProcessCli`,
and therefore through the production `parseCliCommand` to `executeCliCommand`
path. The 13 affected tests and all 160 assertion call sites remain. Nine tests
become async; four were already async.

| Former normal callback cases | Invocations | Imported service invariant | Retained real boundary |
| --- | ---: | --- | --- |
| Record-only creation and duplicate suppression | 3 | Message identity, Turn identity, event persistence, and idempotency | Concurrent duplicate CLI processes |
| Direct Gateway delivery and legacy identity derivation | 2 | Gateway payload projection, token redaction, and legacy Session/Turn fallback | Production fake-OpenClaw child processes |
| Close, retry, rebinding, and persisted authentication | 7 | Immutable outbox, close-state preservation, binding generation, and URL/token routing | Gateway success/failure helpers and the close-during-delivery child |
| Startup reconciliation and accepted-wake settlement | 4 | Retry-monitor launch/reconciliation and no-redelivery settlement | Real detached retry-monitor and Gateway children |
| `chat.send`, `agent.wait`, legacy plan, and `sessions.send` delivery | 4 | Accepted delivery plans, run observation, exact argv, and event recording | Production Gateway child-process transport |

Environment overlays remain scoped by the CLI async-local runtime. `PATH` and
Gateway-token overrides reach the production OpenClaw transport through
`cliEnv()`, while the transport continues to start the fake Gateway executable
itself. The tests do not mutate `process.env`, change cwd, observe the outer CLI
PID, or assert OS exit. The close-during-delivery and callback-retry competition
tests still use separate real CLI processes where process identity and file
competition are the behavior under test.

The in-process `callback` and `retry-callback` commands in this slice complete
their delivered or accepted settlement before returning. Reconciliation only
persists the PID of the real retry-monitor child it launches; it does not claim
an attempt for the in-process caller. No migrated case waits for an outer CLI
`attempt_pid` to die, while the manual in-flight and winner/loser lease cases
remain on their existing imported-failure and real-process paths.

Four explicit callback CLI startup sites remain: Gateway failure and success
helpers, the asynchronous concurrency helper, and the direct retry loser. They
perform 9, 6, 4, and 1 dynamic CLI starts respectively in this file. The
generic helper removes exactly 20 outer CLI starts without removing any
Gateway or retry-monitor start. `test/runtime-log.test.ts` also remains
process-backed because it proves the executable wrapper's `cli_start` and
`cli_finish` records, default `AKK_LOG_DIR` environment routing, and redaction.

The static metric moves from 31 to 30 included startup sites (`cli_process` 21
to 20); all 10 fake-Node sites remain. The machine-readable
`callback-cli-in-process` witness records the moved normal-command cases, while
`callback-cli-boundary` now names the retained winner/loser executable race.

## #126 composer not-accepted in-process migration

The sixth migration slice routes the multilingual Codex composer
not-accepted command through `runInProcessCli`, and therefore through the same
production `parseCliCommand` to `executeCliCommand` path. The test still uses
the real tmux adapter executable, preserves the exact multiline composer after
paste and after Enter, disables synthetic acceptance, and asserts that AKK
dispatches exactly one `C-m`. Its durable not-accepted receipt, close recovery,
and public JSON assertions are unchanged; only the outer Node CLI wrapper is
removed. The explicitly injected process runner remains a visible
`other_process_or_adapter` site and still starts the fake tmux, `ps`, and
`lsof` executables with the command-scoped environment.

This removes one real CLI startup site without moving or hiding a spawn. The
static evidence becomes 29 included sites (`cli_process` 19 plus the unchanged
10 fake-Node sites), a 39.58% reduction from the frozen 48-site baseline. The
machine-readable `terminal-composer-in-process` witness records the imported
command invariant, while raw/managed send, receipt-fence, crash, lock,
acceptance, and terminal-input executable witnesses remain process-backed.

## #126 shared agent CLI in-process migration

The seventh migration slice removes the synchronous outer-Node
`runAgentCli` wrapper from `test/agent-cli-fixtures.ts`. All 197 former call
sites are classified by behavior. Normal deterministic commands now await the
shared `runAgentCliInProcess` path, which still executes the production
`parseCliCommand` to `executeCliCommand` boundary. Across parameterized tests
and shared fixture calls, 214 of the former 233 dynamic outer CLI starts move
in process. The remaining 19 dynamic starts use `runAgentCliAsync` because the
asserted behavior requires an independently dying PID, exit 86, a live monitor
or handoff singleton, cross-process lock competition, or a detached
monitor/retry child whose PID is observed.

The shared runner scopes environment, cwd, caller PID, wall and monotonic
clocks, and sleeps to one imported command. CLI JSON fixtures continue to
select the production static terminal, process, Codex-session, Claude-agent,
and version adapters. A command that instead supplies a fake `PATH` receives
the production `TmuxTerminalControlProvider`, `SystemTerminalProcessSource`,
and `CodexStoreAdapter` with one command-scoped runner. Fake `tmux`, `ps`,
`lsof`, and `claude` executables therefore remain real adapter subprocesses;
their single visible `spawnSync` call site is classified as
`other_process_or_adapter`, not hidden or counted as an imported CLI.

The 70 affected shard test declarations, the one parameterized native-
inspection declaration, and all 1,223 assertion call sites remain.
The static metric becomes 28 included sites (`cli_process` 18 plus the
unchanged 10 fake-Node sites), a 41.67% reduction from the frozen 48-site
baseline. The adapter runner raises the diagnostic-only
`other_process_or_adapter` count from 11 to 12 while deleting the synchronous
CLI startup site. No production source changes are part of this slice.

## #126 dynamic subprocess reduction attestation

The static call-site count above remains a cheap architecture diagnostic. It
is not the final proof for the requirement to remove at least 60% of redundant
outer CLI starts: one helper can execute a call site many times, and moving a
`spawn` into another helper must not improve the result.

Run the final same-machine process-tree attestation from a clean worktree:

```sh
node scripts/measure-subprocess-dynamic-evidence.js \
  --output /tmp/akk-subprocess-evidence.json
```

This command performs no install and uses no network service. It verifies that
`package-lock.json` is byte-identical at current HEAD and the immutable
`ea592a88d7af4a709e7a7a1b989dd29e61932935` baseline, creates a detached
temporary baseline worktree, links the already-present `node_modules`, builds
both revisions, and runs the full tier at concurrency four once per revision.
Both full runs must pass; a partial or failed run is not accepted as evidence.

`scripts/subprocess-dynamic-hook.cjs` is preloaded before the test workers. It
patches every standard `node:child_process` start entry point, synchronizes the
patched CommonJS exports into ESM named imports, and propagates the preload and
run identity even when a caller supplies an explicit stripped `env`. Every
launch also propagates one random, non-secret call ID into the child boot, so
synchronous launches are associated directly without scanning PIDs created by
other concurrent workers. Nested
implementations such as `exec` calling `execFile` emit one record for the real
child rather than two wrapper records, and `util.promisify.custom` remains
usable.

The attestation runs each full tier in one new POSIX process group. The hook
records every explicitly detached child as another process-group root. After
the direct runner exits, measurement waits on the kernel until the runner group
and every recorded detached group are empty; a shell that exits after forking a
background descendant therefore cannot create an unobserved quiet gap. Trace
files are read twice only after all groups are empty, and any live group fails
closed at the configured 30-second timeout. This local attestation consequently
supports macOS and Linux and fails closed on Windows. The baseline completion
finishes before current measurement starts, and the current completion finishes
before either trace is summarized. The final
count comes from observed CLI process boots and their process ancestry, not
from source locations. Moving a start behind a shared Node helper, shell, or
another call expression therefore does not make that start disappear. A
targeted CLI start without its corresponding boot, or a CLI boot without an
originating test, makes the attestation fail closed.

The denominator is the observed full-tree count at the immutable baseline;
the 233-call shared `runAgentCli` migration inventory is only one family and is
not misreported as the global baseline. Current HEAD must be at most 40% of the
same observed baseline (at least a 60% reduction). The report
contains only command basenames, CLI actions, option names, counts, status or
signal outcomes, and test paths; message bodies, tokens, environment values,
and raw argv are never recorded.

The reduction gate is paired with retained real-process checks so deleting or
reclassifying necessary coverage cannot satisfy it. The current full trace
must still demonstrate:

- real doctor argv and non-zero OS exit;
- a crash-injected CLI exit with status 86;
- overlapping CLI processes for Store/terminal lock competition;
- a live child PID and a `SIGKILL` monitor-recovery boundary;
- real fake-Gateway (`openclaw`) execution; and
- real `tmux`, `ps`, `lsof`, and `claude` adapter subprocesses.

Each retained observation is tied at runtime to its explicitly scoped,
allowlisted `TestContext.name`. The canonical path and exact test name in
`config/subprocess-dynamic-evidence.json` are immutable validation inputs, not
replaceable substring hints. Multiple argv,
exit, signal, or live-PID requirements on one boundary must be satisfied by the
same observed CLI process; unrelated children in the same file cannot be
combined into a passing witness. Multi-command adapter boundaries likewise
require every command beneath one outer CLI process, so separate tests in the
same source file cannot be combined into a passing case. Boundaries sharing one
canonical test name also share one command group. The retained Claude and
terminal-adapter witness is the raw background send case, where one outer CLI
process owns every observed `claude`, `tmux`, `ps`, and `lsof` child. The normal
fast evidence test validates that immutable configuration and executes a real
process-group probe in which an exited shell leaves a delayed 1.5-second
background CLI with an explicit stripped environment. A second CJS/ESM matrix
covers every sync and async launch API plus promisified `execFile`, exact
call-ID deduplication, and stripped-environment propagation; an overlapping
sync/concurrent-writer probe prevents shared-trace PID inference from returning.
Those probes transparently
add ten fake-Node source sites to the diagnostic scope, so its included count
is now 38 of 48 (`cli_process` 18 and `fake_node_process` 20);
one fork probe is classified separately as `other_process_or_adapter`, and the
dynamic full-tree ratio, not these measurement-only probes, is the final 60% gate.
It validates the already-active preload without recursively starting its probe
while the outer dynamic attestation runs, avoiding a measurement of the
measurement itself. The expensive two-revision full attestation remains an
explicit final/local gate rather than running inside ordinary fast tests.

## #108 performance record

The pre-refactor maintainer baseline was 48 files / 683 tests / about 573
seconds. By v0.11.3 it had grown to 48 files / 696 tests; with the two manifest
guards added by this work, the comparable before profile was 49 files / 698
tests / 513.96 seconds. The final stable profile is 59 files / 698 tests /
301.05 seconds, a 41.4% reduction with no removed tests. A higher-concurrency
passing run reached 240.13 seconds but was not adopted because repeated stress
caused resource-starvation false failures.

See [the complete #108 performance report](test-performance-issue-108.md) for
the before/after critical paths and why the remaining real-process gates make a
stable 180-second full suite unattainable without the next handler/provider
injection refactor.

Issue #120 completed that next handler/provider-injection phase for the three
largest lifecycle families. See
[the #120 performance report](test-performance-issue-120.md) for the in-process
semantic inventory, retained black-box contracts, and final three-run profile.

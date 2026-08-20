# Test performance report for Issue #120

This report records the second test-performance phase described by Issue #120.
Measurements are comparable only when they use the same maintainer machine,
Node.js version, file concurrency, and warm compile-cache mode. The v0.11.7
baseline and final profiles were measured on 2026-08-10 with Node.js v24.18.0
on Darwin arm64, concurrency 4, and a warm shared compile cache.

## Baseline

| Measurement | v0.11.7 baseline |
| --- | ---: |
| Test files | 61 |
| Runtime tests | 769 |
| Full `npm test` wall time | 432.31 s |
| Node test duration | 430.99 s |
| Fast tier | 28 files / 435 tests / 6.94 s including build |
| Integration tier | 33 files / 334 tests / approximately 98% of wall time |

The count itself was not the bottleneck. The 435-test fast tier completed in
under seven seconds; repeated CLI processes, fake terminal/process/SQLite
commands, and real polling or composer-settle windows dominated the full run.
Increasing file concurrency was not used because the concurrency 6/8 results
from Issue #108 produced nested-process starvation and false bounded-timeout
failures.

## Critical-path migration inventory

| Test family | Before | Migrated shape | Focused after median | Change |
| --- | ---: | --- | ---: | ---: |
| `native-thread-lifecycle-recovery-cli.test.ts` | 19 tests / approximately 174 s | 17 in-process semantic cases + 2 process goldens | 25.224 s | -85.5% |
| `codex-no-rollout-binding-cli.test.ts` | 21 tests / 167.75 s | 18 in-process semantic cases + 3 process goldens | 41.366 s | -75.3% |
| Sticky rollout lifecycle | 1 stateful process scenario / 119.09 s | 7 independent Store-seeded core cases + 1 process golden | 32.016 s | -73.1% |

The sticky semantic cases now live in
`codex-sticky-rollout-lifecycle-core.test.ts`; the retained executable contract
remains in `codex-sticky-rollout-lifecycle-cli.test.ts`. The migration changes
the execution layer, not the safety assertions.

The three focused final samples were 25.224/26.437/24.810 seconds for recovery,
41.706/41.366/41.264 seconds for no-rollout binding, and
32.046/32.016/31.405 seconds for sticky lifecycle. Earlier development checks
reached 24.36 seconds and 38.33 seconds for the first two families; those
one-off values are not substituted for the final repeated medians.

## Injectable command boundary

The emitted `src/cli.ts` entry is now limited to parsing `process.argv`, calling
the command core, forwarding stdout, and applying the returned/fatal exit
status. `src/cli-core.ts` exports `parseCliCommand` and `executeCliCommand`.
Importing that module does not inspect argv, run a command, write output, or
exit the process; a dedicated child-process import probe preserves that
contract.

`executeCliCommand` scopes injected dependencies to one asynchronous execution.
The available seams include:

- terminal provider registry and terminal process source;
- Codex session/rollout and native lifecycle providers plus Claude agent rows;
- running-agent version and process-birth observations;
- cwd, environment, pid, wall/monotonic clocks, async/synchronous sleep;
- stdout, exit handling, and runtime logging.

The in-process fixtures use recording terminal providers, mutable process
snapshots, explicit agent identity adapters, and virtual time. Production
parsing, lifecycle policy, Store/CAS code, bridge sequencing, and error
classification still execute; tests no longer pay for a fresh Node CLI plus
fake executables for every semantic branch.

## Semantic coverage moved in-process

### Native lifecycle recovery

The in-process matrix retains:

- exact-before rollback and exact-after roll-forward without replaying the
  native lifecycle command;
- source/target ownership conflicts, target CAS conflict, and partial-detach
  prevention;
- composer clear failure, non-empty composer refusal, and stale status-screen
  rejection;
- status-only recorded-before recovery and verified candidate inode drift;
- third-identity quarantine, later exact-after recovery, and direct recovery
  before a raw send creates one Turn;
- Codex resolver failure and no-rollout evidence handling;
- Claude exact-before rollback, third-identity quarantine, ambiguous exact-PID
  rows, and target ownership conflicts.

### Virgin/no-rollout Codex binding

The in-process matrix retains:

- rejected production preflight cleanup, rollout discovery races, attach setup
  failure, and proved text-dispatch failure before any task input;
- fenced New/Resume availability after a rejected virgin attach;
- provisional-orphan reconciliation, external native-thread drift, and PID
  reuse behavior;
- ambiguous/unverifiable ownership, status-card/rollout disagreement, process
  birth mismatch, and exact status-card binding refinement;
- suppression of reconcile while Turns, transitions, or dispatch ledgers are
  unresolved;
- unmanaged lifecycle-token freshness and restorable-origin live-gate fences;
- native status inspection snapshot, composer, Store-mutation, version, busy
  state, and post-injection process-drift fences.

### Sticky rollout lifecycle

The former 1,488-line chained scenario is split into independently seeded
cases for:

- draft rejection both before probing and before lifecycle mutation;
- A -> New B isolation and exact transition/dispatch-ledger commitment;
- B send rejection on drafts or wrong status, followed by exact B rollout
  materialization with no A leakage;
- snapshot-bound `previous` navigation A -> B without creating a Turn;
- B -> New C companion-root handling and exact C materialization;
- monitor stall handling while preserving the active C binding; and
- fail-closed behavior for an unknown fourth open rollout without Store or
  terminal mutation.

## Retained black-box process contracts

The following process tests are intentional. Each proves a boundary that the
in-process layer does not replace:

| Domain | Retained executable contract |
| --- | --- |
| CLI import/entry | Importing the core is side-effect free; existing CLI UX coverage retains executable argv, output, redaction, and exit behavior. |
| Virgin Codex attach | The emitted CLI wires real command adapters for tmux/process/SQLite, sends the exact text/Enter vectors, and persists matching Session/Turn binding generations. |
| Prepared lifecycle crash | A real CLI process exits with the deliberate code 86 after the prepared fence, preserving executable failure classification and recoverable state. |
| Codex native inspection | The emitted CLI materializes `/status`, waits across the real 121 ms suppression boundary, sends exactly one Enter, redacts status output, and creates no Store artifacts. |
| Codex recovery | One dispatching exact-before case proves executable wiring, `C-u` composer clearing, `/status` probing, rollback, and no lifecycle replay. |
| Claude recovery | One submitted exact-after case proves the emitted CLI uses Claude identity evidence to roll the binding forward without replay. |
| Sticky rollout | One emitted CLI + tmux/process/SQLite-adapter A -> B -> A path proves `/clear`, snapshot-bound previous selection, exact `/resume <uuid>`, and no Turn creation. |

Real SQLite WAL/checkpoint, filesystem-lock, Store protocol, compatibility, and
other process-boundary suites remain in their existing domain files. They were
not converted or deleted merely to improve this profile.

## Fail-closed affected-test workflow

`npm run test:affected` is a build-once local feedback command. It reads NUL-safe
Git path output and, when supplied, an explicit comparison base:

```bash
npm run test:affected
npm run test:affected -- --base origin/main
```

For a known change it runs the complete fast tier, then the exact mapped
integration manifest entries. A changed integration test selects itself; a
fast test or documentation-only change adds no integration worker. Branch
commits, staged/unstaged work, and untracked files are included when an explicit
base is used.

Selection fails closed to `test:full` when:

- the Git diff/base cannot be read or resolved;
- a mapped test is absent from the integration manifest;
- a changed path is unknown; or
- exact Store/protocol, shared production kernel, selector, or architecture
  authority changes.

Normal production domains select at most five integration witnesses. Known
test helpers add their transitive integration consumers. Tier-manifest changes
require an additive, same-diff content proof, and package plus lockfile changes
require a synchronized version-only proof; all other manifest semantics remain
full.

The full tier itself contains the complete fast and integration manifests, so
the fast tier is never omitted. `test:affected` narrows local feedback only;
`npm test` remains mandatory for merge and release verification.

## Compatibility and safety retained

This refactor does not change production timing windows or default test
concurrency, and it does not weaken or remove:

- full native UUID, fresh snapshot/candidate token, binding generation, CAS,
  pane/PID/process-birth, cwd, ownership, and capability fences from #87;
- no-input versus submission-uncertain classification, composer
  clearing/materialization, or single-Enter evidence;
- exact-before, exact-after, third-identity, candidate inode, PID ownership,
  reconcile-suppression, and sticky/multiple-root behavior;
- opt-in #88 native Codex and Claude lifecycle live smoke;
- Store protocol/migration and v0.11.x artifact compatibility; or
- Codex 0.146.x/0.147.0 and Claude Code 2.1.218/2.1.226 coverage.

No supported product behavior or version contract was removed as test cleanup.

## Final repeated profile

Three successful profiles used the same machine, Node.js v24.18.0, concurrency
4, and warm compile-cache mode. The profile JSON reports Node test-runner
duration, so the comparison below uses the baseline Node duration rather than
mixing it with shell/build wall time.

| Measurement | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Files / tests | 65 / 789 | 65 / 789 | 65 / 789 | 65 / 789 |
| Result | pass | pass | pass | pass |
| Profile-reported duration | 269.048 s | 262.413 s | 261.837 s | **262.413 s** |

The median is 39.1% below the 430.99-second baseline Node duration even though
the suite grew by four files and 20 tests. A separate ordinary `npm test`
validation passed 789/789 with 265.392 seconds reported by Node and 266.65
seconds shell wall time. The final fast tier passed 454/454 in 7.048 seconds of
Node duration and 8.3 seconds including its build, remaining below the
10-second limit.

Reproduction commands:

```bash
npm run test:profile -- --output /tmp/akk-120-profile-1.json
npm run test:profile -- --output /tmp/akk-120-profile-2.json
npm run test:profile -- --output /tmp/akk-120-profile-3.json
npm run test:fast
```

Phase A is achieved: the stable three-run median is 262.413 seconds, 37.587
seconds inside the 300-second ceiling, and the fast tier remains below 10
seconds. Phase B is not achieved by this change. Reaching a stable median at or
below 180 seconds remains follow-up work on repeated semantic subprocesses in
the agent CLI shards and other process-heavy integration domains. That work
must preserve the black-box contracts above; it must not be hidden by increased
concurrency, shorter production waits, or removed safety coverage.

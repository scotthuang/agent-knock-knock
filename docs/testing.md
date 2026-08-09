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

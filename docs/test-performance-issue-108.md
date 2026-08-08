# Test performance report for Issue #108

This report was recorded on the same maintainer machine on 2026-08-08 with
Node.js v24.18.0 on Darwin arm64. Both profiles used the checked-in JSON
reporter, the same warm shared Node compile-cache mode, and all 698 runtime
tests. The source checkout was dirty only because the profiling implementation
and sharding were the changes under measurement.

## Summary

| Profile | Files | Tests | Concurrency | Result | Wall time | Change |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| Before: one serial `agent-cli.test.ts` | 49 | 698 | Node default | pass | 513.96 s | baseline |
| Sharded peak throughput | 59 | 698 | Node default | pass | 240.13 s | -53.3% |
| Final stable default | 59 | 698 | 4 | pass | 301.05 s | -41.4% |

The peak-throughput run demonstrated the benefit of sharding, but repeated
stress runs at concurrency 8 and 6 starved nested CLI/fake-terminal processes:
test-only 30-second child deadlines fired, and terminal submission fixtures
could cross production's real bounded deadline. Those runs were rejected even
though they were faster. The final runner caps concurrency at four and permits
an explicit `AKK_TEST_CONCURRENCY` override for controlled experiments.

The inner loop is separate: the final fast tier contains 27 files and 374 tests
and completes in under 10 seconds on the same machine.

## Critical path before

| File | Tests | Worker duration |
| --- | ---: | ---: |
| `test/agent-cli.test.ts` | 69 | 512.91 s |
| `test/codex-no-rollout-binding-cli.test.ts` | 17 | 167.41 s |
| `test/native-thread-lifecycle-recovery-cli.test.ts` | 19 | 149.46 s |
| `test/codex-sticky-rollout-lifecycle-cli.test.ts` | 1 | 124.47 s |
| `test/native-thread-lifecycle-cli.test.ts` | 1 | 49.19 s |
| `test/callback-cli.test.ts` | 30 | 46.35 s |

The 69 `agent-cli` runtime tests were serialized in one 12,149-line file. The
refactor moved the exact unchanged test bodies into 11 process-isolated shards;
their concatenated source hash and runtime count match the original.

## Critical path after

| File | Tests | Worker duration |
| --- | ---: | ---: |
| `test/codex-no-rollout-binding-cli.test.ts` | 17 | 167.75 s |
| `test/native-thread-lifecycle-recovery-cli.test.ts` | 19 | 144.00 s |
| `test/codex-sticky-rollout-lifecycle-cli.test.ts` | 1 | 119.09 s |
| Slowest `test/shards/agent-cli-*.test.ts` worker | 5 | 55.74 s |
| `test/native-thread-lifecycle-cli.test.ts` | 1 | 44.10 s |
| `test/callback-cli.test.ts` | 30 | 35.57 s |

## Why the stable full suite remains above 180 seconds

The remaining top three files are real process gates, not obsolete duplicate
coverage. They repeatedly launch the built CLI plus fake `tmux`, `ps`, `lsof`,
and SQLite processes to preserve virgin attach/reconcile behavior, exact native
recovery fences, sticky rollout handling, WAL/checkpoint behavior, and fail-
closed identity checks. A separate serial verification of only
`native-thread-lifecycle-recovery-cli.test.ts` and the receipt-fence shard took
180.08 seconds for 24 passing tests. That pair alone consumes the issue target
before the other 674 tests run.

Reaching a stable full-suite wall below 180 seconds therefore requires a second
architectural step: inject CLI handlers/providers and clocks for semantic cases,
split the sticky lifecycle state chain into independent Store-seeded scenarios,
and retain a thin black-box process layer. This PR intentionally does not delete
those recent regression fences, shorten production timing windows, disable
process isolation, or force-exit child processes merely to hit the number.

## Reproduce

```bash
npm run test:profile -- --output /tmp/akk-profile.json
AKK_TEST_CONCURRENCY=8 npm run test:profile -- --output /tmp/akk-profile-c8.json
```

The JSON contains metadata, totals, every file and test duration, slowest tests,
and full failure stacks. Compare runs only on the same machine, Node version,
concurrency, and compile-cache mode.

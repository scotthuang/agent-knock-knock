# Contributing

Thanks for taking the time to improve Agent Knock Knock.

## Development Setup

Use Node.js 22.19 or newer; Node.js 24 is recommended. GitHub Actions runners are intentionally disabled during the current rapid-iteration phase, so pull requests must include the local verification results described below. The supported Node.js boundary remains part of release compatibility even though GitHub does not currently run a hosted matrix.

```bash
npm ci
npm run build
npm run test:fast
```

The fast tier is the default development loop. Add the integration files
mapped to the subsystem you changed, then run the full suite before opening a
pull request. The checked-in tier manifest and targeted commands are documented
in [docs/testing.md](docs/testing.md).

For local OpenClaw testing, link the plugin from this checkout:

```bash
openclaw plugins install --link .
openclaw plugins enable agent-knock-knock
openclaw gateway restart
```

## Checks

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` is an alias for `test:full`; it never selects a weaker tier. Use
`npm run test:profile -- --output /tmp/akk-test-profile.json` when a change may
affect test runtime, subprocess behavior, polling, or concurrency.

The pull request description is the verification record while hosted Actions
are disabled: include the local Node.js version, exact commands, pass counts,
and any intentionally skipped credentialed smoke. `package.json` currently has
no separate lint script, so use `git diff --check` as the whitespace/patch
format gate and report that fact explicitly.

OpenClaw compatibility changes must also pass the isolated host matrix:

```bash
npm run compat:openclaw
```

The matrix derives the supported Host, Plugin API, and build versions from `package.json`, then verifies the adjacent failing API boundary. It uses only temporary OpenClaw state and does not make credentialed coding-agent turns.

If your change touches logging, callbacks, or trace output, also review the output for secrets and local-only data. Trace output must not expose agent thinking text, raw callback payloads, gateway tokens, API keys, passwords, or proxy credentials.

## Native Lifecycle Live-Smoke Diagnostic

This optional diagnostic runs a fresh real-agent check in addition to the
deterministic suite. The runner uses existing authenticated coding-agent
processes and can incur API cost. It never launches, upgrades, restarts, kills,
or arbitrarily selects a process, and ordinary `npm test` never invokes it.
During the current rapid-iteration phase, npm and ClawHub publishing do not
require this diagnostic or consume its evidence.

Prepare one supported Codex pane and one supported Claude Code pane in tmux.
Both must be idle with an empty composer and have no active Turn, approval,
callback, dispatch, or lifecycle transition. Record each exact target, tmux
pane PID, and running agent version:

```bash
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid} #{pane_current_command}'
npm run build
node dist/src/cli.js list --terminal-debug
```

Each starting native thread `A` must already be persisted by its agent as an
exact same-workspace resume candidate. In particular, a newly launched Codex
composer with no completed native turn is not a safe origin: `/clear` can erase
its only identity before Codex writes a resumable thread row and rollout. Seed
that pane with one harmless native turn, wait until it is idle, and verify the
thread is listed before running the diagnostic. The diagnostic's internal New preflight
rechecks unique Session ownership and a fresh candidate token before `/clear`.
Do not type in either selected pane while the matrix is running: AKK's locks
serialize AKK operations, but they cannot fence direct human tmux input.

Keep the evidence outside the repository. The worktree must be clean because
the result is bound to `git rev-parse HEAD` and the current `package.json`
version. The runner also fingerprints its compiled JavaScript before and after
the matrix and fails closed if it changes. Run the complete matrix with both
explicit opt-ins:

```bash
AKK_RUN_LIVE_LIFECYCLE_SMOKE=1 npm run smoke:lifecycle -- \
  --confirm-live \
  --codex-target <session:window.pane> \
  --codex-expected-pane-pid <pane-pid> \
  --codex-expected-version <codex-version> \
  --claude-target <session:window.pane> \
  --claude-expected-pane-pid <pane-pid> \
  --claude-expected-version <claude-version> \
  --evidence </absolute/private/path/live-lifecycle-evidence.json>
```

Omit all three `--claude-*` arguments for a Codex-only diagnostic run, or all
three `--codex-*` arguments for a Claude-only run. Complete matrix evidence
still requires both agents.

The runner reports one of three outcomes:

- `passed`: the exact pane completed `A → new B → one Send in B → resume A`
  and finished idle on A with the same process and workspace.
- `failed`: a check failed with a proven outcome. Inspect the named pane and
  evidence before deciding whether to run again.
- `uncertain`: AKK cannot prove whether submitted terminal input completed.
  Do not rerun the lifecycle command. Inspect that exact pane, run
  `node dist/src/cli.js list --terminal-debug`, and recover manually with only
  the newly advertised exact action once the current native thread is known.

The persisted starting thread `A` may already have a managed AKK Session or
may be an unmanaged, verified native thread. Evidence records that distinction
explicitly.
For an unmanaged start, New has no source Session, creates `B` at binding
generation 1, and exact Resume materializes a new Session for `A` at generation
1. For a managed start, exact Resume returns to the same `A` Session and advances
its binding generation by exactly one. Neither lifecycle operation may create a
Turn in either path.

The JSON contains only allowlisted diagnostic facts and salted fingerprints. It
does not contain prompts, replies, transcripts, raw native/Session/Turn/
transition/binding IDs, callback payloads, or credentials. A non-passing run
still writes evidence for diagnosis, but it cannot pass local verification.

To validate passing evidence against the exact clean commit locally:

```bash
release_version="$(node -p "require('./package.json').version")"
release_commit="$(git rev-parse HEAD)"

npm run smoke:lifecycle:attest -- \
  --evidence </absolute/private/path/live-lifecycle-evidence.json> \
  --expected-version "${release_version}" \
  --expected-commit "${release_commit}" \
  --require-matrix \
  --max-age-hours 72
```

The verifier and attestation format remain available so a mandatory release
gate can be restored later without redesigning the lifecycle evidence model.

### Opt-in monitor fault injection

#93 adds a separate liveness check to the #88 diagnostic contract. Run it only
against a disposable, already managed Turn while the OpenClaw Gateway and its
AKK plugin service are running:

1. Start one real background Turn in an explicitly selected idle tmux pane and
   retain its `state_path` and `event_log_path` from the send result.
2. From that Turn's event log, read the latest
   `terminal_bridge_monitor_launch.pid`. Verify it is neither the tmux pane PID
   nor the Codex/Claude process PID, then terminate only that monitor process.
3. Do not invoke AKK `status`, `list`, or `reconcile-monitors`. Let the native
   Turn finish normally.
4. Within 30 seconds after durable completion, while the Store remains
   writable, require evidence for `terminal_bridge_monitor_exit_observed`, a
   `terminal_bridge_monitor_launch` whose reason is
   `unexpected_exit_recovery`, and the replacement
   `terminal_bridge_monitor_started`. The detached child and supervisor append
   their records independently, so do not require those diagnostic records to
   have a total ordering. Require exactly one
   `terminal_bridge_completion_detected`, exactly one
   `terminal_bridge_completion_claimed`, and one immutable `done` callback or
   outbox entry.
5. Verify the replacement kept the same Session, Turn, terminal binding ID and
   binding generation. A changed binding must fence the old monitor instead of
   completing the Turn.

This scenario deliberately kills only AKK's detached monitor. It does not
weaken the lifecycle runner's promise never to launch, restart, upgrade, or
kill a coding-agent process. Store-lock fault injection is deterministic in the
test suite: holding `.akk-writer.lock` beyond ten seconds must produce a
deferred diagnostic, resume after release, and never be reported as binding
supersession.

## Adding a Terminal Agent Adapter

- Implement the `TerminalAgentAdapter` interface defined in `src/terminal-agent-adapter.ts`, including process classification, screen parsing, declared capabilities, ordered approval keys, ordered cancellation keys, and any screen or durable completion detection.
- Add the complete adapter once to `productionTerminalAgentAdapters` in `src/terminal-agent-registry.ts`. Unsupported capabilities must stay disabled so the bridge fails closed.
- Keep tmux discovery, capture, and input in `TerminalControlProvider`; agent-specific prompt and completion parsing belongs in the adapter.
- Add adapter and bridge tests covering discovery, agent-aware IDs, status, send, cancel, approval revalidation and key order, monitoring, completion, and disabled capabilities. Keep legacy `terminal:tmux:<target>:<pid>` IDs working as Codex.

## Pull Requests

- Keep changes focused on one behavior or feature.
- Include tests for CLI behavior, protocol changes, callback delivery, or trace parsing.
- Update `README.md` or `CHANGELOG.md` when user-visible behavior changes.
- Do not commit `dist/`, `node_modules/`, runtime logs, local OpenClaw state, or `.env` files.
- Complete the pull request checklist and attach local typecheck, full test, package, and compatibility results. When hosted Actions are re-enabled, the Node.js 22 and 24 jobs become required again.

For installation and usage help, see [SUPPORT.md](SUPPORT.md).

## Security Reports

Do not report vulnerabilities through public issues. See `SECURITY.md`.

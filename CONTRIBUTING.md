# Contributing

Thanks for taking the time to improve Agent Knock Knock.

## Development Setup

Use Node.js 22.19 or newer; Node.js 24 is recommended. CI currently verifies the latest Node.js 22 and 24 releases.

```bash
npm ci
npm run build
npm test
```

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

OpenClaw compatibility changes must also pass the isolated host matrix:

```bash
npm run compat:openclaw
```

The matrix derives the supported Host, Plugin API, and build versions from `package.json`, then verifies the adjacent failing API boundary. It uses only temporary OpenClaw state and does not make credentialed coding-agent turns.

If your change touches logging, callbacks, or trace output, also review the output for secrets and local-only data. Trace output must not expose agent thinking text, raw callback payloads, gateway tokens, API keys, passwords, or proxy credentials.

## Native Lifecycle Live-Smoke Release Gate

Lifecycle-sensitive releases require a fresh real-agent check in addition to
the deterministic suite. The runner uses existing authenticated coding-agent
processes and can incur API cost. It never launches, upgrades, restarts, kills,
or arbitrarily selects a process, and ordinary `npm test` never invokes it.

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
thread is listed before running the gate. The gate's internal New preflight
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
three `--codex-*` arguments for a Claude-only run. A release attestation still
requires the complete Codex + Claude matrix.

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

The JSON contains only allowlisted release facts and salted fingerprints. It
does not contain prompts, replies, transcripts, raw native/Session/Turn/
transition/binding IDs, callback payloads, or credentials. A non-passing run
still writes evidence for diagnosis, but it cannot be attested for release.

After the version change is committed and the full matrix passes on that exact
clean commit, validate the evidence and create the annotated tag:

```bash
release_version="$(node -p "require('./package.json').version")"
release_commit="$(git rev-parse HEAD)"
tag_message="$(mktemp)"

npm run smoke:lifecycle:attest -- \
  --evidence </absolute/private/path/live-lifecycle-evidence.json> \
  --expected-version "${release_version}" \
  --expected-commit "${release_commit}" \
  --require-matrix \
  --max-age-hours 72 \
  --output "${tag_message}"

git tag -a "v${release_version}" -F "${tag_message}"
git push origin "v${release_version}"
```

The npm release workflow and both ClawHub stages independently extract and
verify that annotated-tag attestation before publishing. The ClawHub publish
job repeats the freshness check because GitHub permits a single job to be rerun
later. Missing, malformed, failed, stale, wrong-version, wrong-commit, or
single-agent evidence fails closed. Delete the temporary tag-message file after
pushing the tag.

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
- Complete the pull request checklist and wait for the Node.js 22 and 24 CI jobs to pass.

For installation and usage help, see [SUPPORT.md](SUPPORT.md).

## Security Reports

Do not report vulnerabilities through public issues. See `SECURITY.md`.

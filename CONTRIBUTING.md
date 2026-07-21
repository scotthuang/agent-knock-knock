# Contributing

Thanks for taking the time to improve Agent Knock Knock.

## Development Setup

```bash
npm install
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
```

If your change touches logging, callbacks, or trace output, also review the output for secrets and local-only data. Trace output must not expose agent thinking text, raw callback payloads, gateway tokens, API keys, passwords, or proxy credentials.

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

## Security Reports

Do not report vulnerabilities through public issues. See `SECURITY.md`.

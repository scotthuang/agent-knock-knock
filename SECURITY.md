# Security Policy

## Supported Versions

Agent Knock Knock is currently an early public project. Security fixes target the `main` branch unless a release branch is explicitly announced.

## Reporting a Vulnerability

Please do not open public GitHub issues for vulnerabilities or sensitive findings.

Report privately by contacting the repository maintainers through GitHub. Include:

- A concise description of the issue.
- Steps to reproduce, if safe to share.
- Whether the issue exposes credentials, local files, OpenClaw session data, callback payloads, or agent trace output.
- Any relevant version, commit, or environment details.

## Sensitive Data Guidelines

Agent Knock Knock stores local task state and diagnostic logs under `~/.agent-knock-knock` by default. Do not share those files publicly without reviewing them first.

Sensitive data that should not appear in issues, logs, screenshots, or pull requests includes:

- API keys, gateway tokens, passwords, and bearer tokens.
- Proxy credentials.
- Raw callback payloads that contain private task context.
- OpenClaw channel session keys for private chat channels.
- Agent thinking text.

The project includes redaction and safe trace summaries, but users and contributors should still review diagnostics before sharing them.

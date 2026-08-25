# Agent Knock Knock for DeepSeek Harness

This package is the native DeepSeek Harness Web connector for Agent Knock
Knock (AKK). Installing the bundle adds `/akk` and the 16 AKK semantic tools to
every live Agent immediately. There is no `/akk-bind` step and no session id for
the user to copy.

The connector is developed in the AKK repository but is an independent npm
package. It does not modify DeepSeek Harness and has its own version, build,
tests, lockfile, bundle manifest, and future release tag.

## Compatibility

The first release intentionally supports exactly DeepSeek Harness
`0.1.1-rc.2` on the resident Web Host and Node.js `>=22.19.0`. Activation locates
the real `@deepseek-ai/dsh` launcher and requires that launcher plus its
`dsh-agent`, `dsh-commands`, `dsh-llm`, and `dsh-tools` package set to be exact
`0.1.1-rc.2`; an unsupported, missing, or split Host fails before mounting.

Headless/one-shot Harness processes, Host-exit callback continuity, and Windows
named pipes are not supported in this release.

## Installation

Once this connector has been published, add its bundle to the Web profile:

```sh
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
```

For development in this repository, build the AKK root package and this child
package, then add the child directory with the DeepSeek Harness plugin command.
The published connector depends on the exact AKK runtime version `0.12.16` so
the Host Adapter API it was tested against cannot drift unexpectedly.

The optional bundle patch mounts only the Host plugin:

```yaml
- insert:
    - id: agent-knock-knock-deepseek-harness
      name: '@scotthuang/agent-knock-knock-deepseek-harness'
```

## Runtime model

- A slash-command invocation receives the exact DSH `Agent` from the command
  service; a tool invocation receives the exact `exec.agent` from the tools
  service.
- The connector validates `ctx.agents.get(agent.id) === agent` and creates a
  private controller id containing a Host-instance nonce, an Agent-incarnation
  nonce, and that Agent's id. Replacing an Agent with the same session id does
  not inherit its route.
- One shared AKK lifecycle service runs per DSH Host. The root AKK Host Adapter
  retains one private tool/command authority registry per exact Agent object.
- DSH receives a discovery schema projected into its enforced rc.2 subset.
  Before a tool can reach the Host Adapter, the connector validates its input
  against the complete original AKK JSON Schema, including conditional,
  pattern, and numeric constraints that DSH discovery cannot represent.
- A private `0700` temporary directory contains the route-bound Host Profile
  and Unix socket. The callback helper is launched with `process.execPath`; its
  socket path and random token are inherited through an allowlisted environment
  and never placed in command arguments.
- Completion callbacks go to the initiating Agent's route. A running Agent
  receives `inject()` and an idle Agent receives `followup()`.
- The synchronous callback acknowledgement means the message was admitted to
  the DSH inbox/session log. It does not claim that the model consumed the
  message or that asynchronous persistence reached stable storage. AKK
  `watch`/`status` remain the recovery path.
- A Host restart creates a new private Profile revision. A Terminal Watch
  persists its complete initiating route, so callbacks owned by the previous
  Host incarnation fail closed instead of being redirected to a new Agent.
  There is deliberately no cross-restart callback continuity in this release;
  inspect it with `status`, or `unwatch` it and create a fresh `watch` under
  the new Host incarnation.
- Exact, process-lifetime idempotency records return the original acceptance id
  for a duplicate. Reusing one idempotency key for different callback content
  is rejected.

## Configuration

The connector accepts an optional lifecycle cadence and the existing AKK plugin
configuration object:

```yaml
- id: agent-knock-knock-deepseek-harness
  name: '@scotthuang/agent-knock-knock-deepseek-harness'
  config:
    lifecycleIntervalMs: 5000
    pluginConfig:
      storeDir: /absolute/path/to/akk-store
```

## Development

Only the fast test tier is used during development:

```sh
npm install
npm run typecheck
npm run test:fast
npm run pack:check
```

No connector package is published by these commands.

## Release safety

`npm run release:check` is check-only. The script rejects a dirty tree, a
non-`main` branch, an unsynchronized upstream, an existing npm version, and any
runtime `file:`, `link:`, or `workspace:` dependency.

Publishing additionally requires both explicit flags:

```sh
npm run release:check -- --publish --confirm-version 0.1.0-rc.1
```

Prereleases use npm tag `next`; stable versions use `latest`. Repository tags
and GitHub Releases use the connector-specific namespace
`deepseek-harness-v<version>` and are created separately after npm verification.

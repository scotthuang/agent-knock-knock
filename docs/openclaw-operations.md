# OpenClaw Operations

This document covers OpenClaw-specific installation choices, optional tool
routing, configuration, approval policy, recovery, and diagnostics. For
ordinary AKK commands and cross-Host reliability semantics, use the
[Operator Guide](operator-guide.md).

## Requirements and compatibility

- Node.js supported by the installed OpenClaw release; Node.js 24 LTS is
  recommended.
- OpenClaw `2026.6.5` or newer for normal packaged installation.
- Plugin API and Gateway `2026.5.12` or newer. The adjacent tested boundary,
  `2026.5.10-beta.2`, lacks the required session workflow API.
- tmux, or local Herdr `0.8.0` using socket protocol 19.
- An authenticated Codex or Claude Code CLI running under the same OS user as
  OpenClaw and AKK.

OpenClaw, AKK, the terminal provider, and the coding agent must share the OS
user because AKK verifies and controls local processes and private terminal
endpoints. Workspace is not a routing boundary: fresh terminal identity and
explicit user selection are.

## Choose one installation path

### ClawHub

This is the normal OpenClaw installation:

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

ClawHub installs the plugin, bundled AKK skill, and package-local relay CLI.
The plugin always uses that bundled relay. It does not add the standalone
`agent-knock-knock` command to the shell `PATH`.

### npm

Use npm only when the standalone shell CLI is also wanted:

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --verify
```

Do not run `install-openclaw` after a ClawHub installation. These are
alternative installation paths. For a nonstandard OpenClaw executable:

```bash
agent-knock-knock install-openclaw --verify \
  --openclaw-bin /absolute/path/to/openclaw
```

## Optional natural-language routing

Direct `/akk ...` commands bypass model tool selection and require no tool
policy change. To let OpenClaw decide to call AKK from natural language, grant
the optional `agent-knock-knock` tools.

With the default `coding` profile and no existing `tools.allow`:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["agent-knock-knock"]
  }
}
```

If a restrictive `tools.allow` already exists at that scope, add
`"agent-knock-knock"` to it instead. Do not configure `allow` and `alsoAllow`
at the same scope. Restart the Gateway after changing tool policy.

## Configuration

AKK requires no project-specific plugin configuration. Optional settings live
under `plugins.entries.agent-knock-knock.config`:

| Option | Default | Purpose |
| --- | --- | --- |
| `storeDir` | `~/.agent-knock-knock/store` | Stable AKK Session, Turn, Watch, receipt, and callback-outbox Store. |
| `openclawBin` | Auto-detected | OpenClaw CLI used by the callback adapter. |
| `codexHome` | Auto-detected | Optional Codex home used for native-session discovery. |
| `idleTimeoutMinutes` | `10080` | Retention checked during controlled reconciliation. |
| `agentTimeoutMinutes` | `60` | Terminal inactivity timeout. |
| `agentHardTimeoutMinutes` | `720` | Maximum monitor lifetime. |

A custom `storeDir` must be a dedicated private directory. AKK initializes a
missing or empty path and refuses a non-empty manifestless directory instead
of guessing how to write it. The complete schema is in
[`openclaw.plugin.json`](../openclaw.plugin.json).

## Manual approval

AKK preserves the coding agent's existing permission mode. An approval
callback is not authorization: the Host must refresh Status, show the current
request, obtain explicit human confirmation, and invoke only the approval
action advertised for that exact prompt.

Claude Code manual approval is deliberately narrow. It supports the current
AKK-managed Turn only and requires an exact one-time Bash **Yes** choice
correlated with the owner-private transcript. Persistent permission choices,
unknown dialogs, and changed evidence remain manual in the TUI.

Codex may also advertise terminal-scoped approval when the exact visible prompt
is known but managed foreground UUID attribution is unavailable. The action is
prefilled with the exact `terminal_id`; never construct or guess it. Both paths
retain the confirmation offer and prompt fence privately and recapture them
under lock immediately before sending one key.

## Automatic approval

Trusted Codex and supported hookless Claude terminal commands can optionally
be auto-approved with a deterministic, default-disabled policy:

```json5
autoApprove: {
  enabled: true,
  rules: [{
    id: "project-read-status",
    agents: ["codex", "claude"],
    workspaces: [
      "/absolute/path/to/project-a",
      "/absolute/path/to/project-b"
    ],
    commands: [["pwd"], ["git", "status"], ["git", "diff", "--stat"]]
  }]
}
```

Place `autoApprove` inside the plugin `config`. Each rule may authorize
multiple canonical workspace roots; `autoApprove.rules[].workspaces` is the
sole workspace boundary for automatic approval and does not limit discovery or
manual control. Rules match only the configured agents and exact argument
vectors. Shell composition, substitutions, globs, environment assignments,
unparseable commands, and paths outside every authorized root remain manual.
Terminal Watch approval notifications never participate in auto-approval.

## Supervisor and callbacks

OpenClaw starts one non-overlapping AKK supervision cycle at startup and after
each previous cycle completes. Managed-Turn monitor recovery and Terminal Watch
reconciliation have independent error boundaries, so one failure does not
starve the other.

With a writable Store, healthy Gateway, successful reconciliation, and an
unchanged Turn binding, AKK prepares one immutable completion message and
outbox entry within 30 seconds after reliable native completion evidence
becomes stable. External transport and wake acknowledgement are outside that
bound. Status remains the manual recovery path when presentation is delayed.

## Troubleshooting

Start with:

```text
/akk doctor
```

With the standalone npm CLI installed, `agent-knock-knock doctor` additionally
checks the executable environment directly.

| Symptom | Recovery |
| --- | --- |
| No eligible terminal | Start authenticated Codex or Claude Code inside tmux or supported Herdr as the same OS user, then refresh `/akk list`. |
| Plugin or callbacks cannot find OpenClaw | Configure `openclawBin`; for npm installation, pass the matching `--openclaw-bin` to `install-openclaw`. |
| Source changes do not appear | Build, reinstall from the checkout, and let the installer perform its single Gateway restart. |
| Turn is `stalled` | Inspect Status and the exact pane; use the advertised Renew action only if the same Turn is still live. |
| Turn is `callback_failed` | Use the advertised Retry Callback action; it reuses the original message identity. |
| Human native-thread switch conflicts with active work | Ask the user whether to keep the old work or take over the current thread. Use only the nested fresh action returned by List. |
| List reports orphaned dispatch or transition state | Inspect the pane, then run only the exact Close recovery command returned by List. It leaves the coding agent and terminal running. |
| Claude approval is not offered | Resolve unsupported, persistent, stale, or uncorrelated dialogs in the TUI. |
| Claude request was not auto-approved | Check the enabled rule, agent, canonical workspace, exact argv, and current screen/transcript evidence. |

Local read-only diagnostics:

```bash
agent-knock-knock status --conversation latest --trace
agent-knock-knock list --terminal-debug
```

Trace and logs must not expose agent reasoning, raw callback payloads,
credentials, tokens, passwords, or proxy secrets.

## Trust and privacy

AKK has no hosted control plane or telemetry and does not change coding-agent
permission settings. Terminal, Session, Turn, Watch, receipt, and log state
stay on the local machine. Claude approval callbacks omit raw commands; Codex
may include bounded visible command detail so the Host can present it for
review.

Task content is still processed by OpenClaw and the coding-agent or model
providers configured by the user. Keep secrets out of prompts and review every
agent's permission mode.

For Store migration, filesystem permissions, retention, and log settings, see
[Storage and Logging](storage-and-logging.md). For development and release
workflows, see [Contributing](../CONTRIBUTING.md) and [Testing](testing.md).

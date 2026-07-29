# Agent Knock Knock in 5 Minutes

This is the canonical ClawHub setup: OpenClaw and a human share one live Codex or Claude Code terminal without changing the coding agent's permission mode.

## Before you start

You need:

- A Node.js version supported by OpenClaw; Node.js 24 LTS is recommended
- OpenClaw `2026.6.5` or newer
- tmux
- An installed and authenticated `codex` or `claude` CLI
- OpenClaw, tmux, and the coding agent running as the same OS user

AKK reuses a coding agent that you start in tmux. It never installs, authenticates, or launches Codex or Claude Code for you.

## 1. Install AKK for one project

Run these commands from the project AKK may edit:

```bash
cd /absolute/path/to/project
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw config set plugins.entries.agent-knock-knock.config.workspace "$(pwd -P)"
openclaw gateway restart
```

The physical path from `pwd -P` gives AKK one canonical workspace boundary. The ClawHub package includes the OpenClaw plugin, bundled AKK skill, and its package-local relay CLI.

## 2. Start the shared terminal

```bash
tmux new-session -s akk-work -c "$(pwd -P)" codex
```

Use `claude` instead of `codex` to share a Claude Code terminal. Wait until the coding agent is authenticated and showing its idle prompt. Detach from tmux with `Ctrl-b`, followed by `d`.

AKK sends work only to a matching Codex or Claude Code pane that is already running and idle inside the configured workspace.

## 3. Run doctor

From any configured OpenClaw channel:

```text
/akk doctor
```

Success starts with:

```text
AKK doctor: ready
```

Doctor verifies the installed plugin and skill, canonical workspace, Gateway health, tmux, and at least one supported coding-agent CLI. It does not make a credentialed model call or require a live pane.

## 4. Send the first task

```text
/akk inspect this repository and summarize it
```

The bare task works when exactly one eligible idle coding-agent pane exists in the configured workspace. If more than one pane is eligible, AKK stops instead of guessing: run `/akk list`, then use `/akk <selector>: <message>`, for example:

```text
/akk @a1b2c3d4: inspect this repository and summarize it
```

Success returns a managed conversation and, when the task finishes, its result. The same tmux pane remains available for direct human control; reattach with `tmux attach -t akk-work`.

## Optional: Enable natural-language delegation

Direct `/akk ...` commands work without changing the OpenClaw tool policy. To let OpenClaw decide to use AKK from a natural-language request, grant the optional `agent-knock-knock` tools in the applicable policy.

If you use the default `coding` profile and do not already have `tools.allow`:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["agent-knock-knock"]
  }
}
```

If a restrictive `tools.allow` list already exists at that scope, add `"agent-knock-knock"` to that list instead. Do not configure `allow` and `alsoAllow` at the same scope.

Restart the Gateway after changing the tool policy.

## Alternative: Install from npm

Use this route only when you also want the standalone `agent-knock-knock` shell command:

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --workspace "$(pwd -P)" --verify
```

Do not run `install-openclaw` after a ClawHub install. The two commands are alternative installation paths.

## Permissions and monitoring

AKK keeps the coding agent's own permission settings. Trusted, exact `autoApprove` rules may approve a supported prompt; everything else remains manual. If monitoring stalls while the same task is still live, inspect `/akk status only` and use `/akk renew only <minutes>` to resume monitoring without sending terminal input.

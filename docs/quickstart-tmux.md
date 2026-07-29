# Agent Knock Knock in 5 Minutes

This is the canonical Agent Knock Knock setup: OpenClaw and a human share the same live Codex or Claude Code terminal. You need a Node.js version supported by your OpenClaw release (Node.js 24 LTS recommended), OpenClaw `2026.6.5`+, tmux, and an authenticated `codex` or `claude` CLI, all running as the same OS user.

## 1. Install and configure

From the project the agent may edit:

```bash
npm install -g @scotthuang/agent-knock-knock && agent-knock-knock install-openclaw --workspace "$PWD" --verify
```

The installer updates only AKK's enabled flag and workspace. Existing plugin settings—including `autoApprove` rules—remain intact, and the Gateway restarts at most once.

## 2. Run doctor

```bash
agent-knock-knock doctor
```

Success means `readiness` is `ready`, at least one supported CLI can return a version, the AKK runtime and skill are loaded, the workspace is canonical, and the Gateway is healthy. Doctor does not make a credentialed model call.

## 3. Start the shared terminal

```bash
tmux new-session -s akk-work -c "$PWD" codex
```

Use `claude` instead of `codex` to share a Claude Code terminal. Detach with `Ctrl-b`, then `d`.

AKK does not launch coding agents. It sends work only to a matching Codex or Claude Code pane that you already started and that is currently at a verified idle prompt.

## 4. Send one chat command

From any configured OpenClaw channel:

```text
/akk inspect this repository and summarize it
```

Because this quickstart starts one coding-agent pane in the configured workspace, the bare task resolves when exactly one eligible idle pane exists. If multiple panes are eligible, AKK stops instead of guessing: run `/akk list`, then target one explicitly with `/akk <selector>: <message>`, for example `/akk @a1b2c3d4: inspect this repository and summarize it`.

Success returns a managed conversation while the same tmux pane remains available for direct human control.

## Permissions and monitoring

AKK keeps the coding agent's own permission settings. Trusted, exact `autoApprove` rules may approve a supported prompt; everything else remains manual. Reattach with `tmux attach -t akk-work` whenever you want to take over. If monitoring stalls while the same task is still live, inspect `/akk status only` and use `/akk renew only <minutes>` to resume monitoring without sending terminal input.

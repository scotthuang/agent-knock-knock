# Agent Knock Knock in 5 Minutes

This is the canonical Agent Knock Knock setup: OpenClaw and a human share the same live Codex or Claude Code terminal. You need a Node.js version supported by your OpenClaw release (Node.js 24 LTS recommended), OpenClaw `2026.6.5`+, tmux, and an authenticated `codex` or `claude` CLI, all running as the same OS user.

## 1. Install and configure

From the project the agent may edit:

```bash
npm install -g @scotthuang/agent-knock-knock && agent-knock-knock install-openclaw --workspace "$PWD" --default-agent codex --verify
```

The installer updates only AKK's enabled flag, workspace, and default agent. Existing plugin settings—including `autoApprove` rules—remain intact, and the Gateway restarts at most once.

## 2. Run doctor

```bash
agent-knock-knock doctor
```

Success means `readiness` is `ready`, the selected CLI can return a version, the AKK runtime and skill are loaded, the workspace is canonical, and the Gateway is healthy. Doctor does not make a credentialed model call.

## 3. Start the shared terminal

```bash
tmux new-session -s akk-work -c "$PWD" codex
```

Use `claude` instead of `codex` if that is your configured agent. Detach with `Ctrl-b`, then `d`.

## 4. Send one chat command

From any configured OpenClaw channel:

```text
/akk send codex: inspect this repository and summarize it
```

AKK must find exactly one actionable Codex target; otherwise it stops and shows candidate short references instead of guessing. Success returns a managed conversation while the same tmux pane remains available for takeover.

## Permissions and monitoring

AKK keeps the coding agent's own permission settings. Trusted, exact `autoApprove` rules may approve a supported prompt; everything else remains manual. Reattach with `tmux attach -t akk-work` whenever you want to take over. If monitoring stalls while the same task is still live, inspect `/akk status only` and use `/akk renew only <minutes>` to resume monitoring without sending terminal input.

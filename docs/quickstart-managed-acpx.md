# Managed ACPX in 5 Minutes

Use this path for managed background Codex, Claude Code, or Cursor tasks with durable AKK state and callbacks. You need a Node.js version supported by your OpenClaw release (Node.js 24 LTS recommended), OpenClaw `2026.6.5`+, and an authenticated coding-agent CLI.

## 1. Install and configure

From the project the agent may edit:

```bash
npm install -g acpx@latest @scotthuang/agent-knock-knock && agent-knock-knock install-openclaw --workspace "$PWD" --default-agent codex --mode acpx --verify
```

Use `--default-agent claude` or `cursor` when preferred. Existing AKK approval policy remains intact, and the Gateway restarts at most once.

## 2. Run doctor

```bash
agent-knock-knock doctor --mode acpx
```

Success means `readiness` is `ready`, ACPX and the selected agent CLI can return versions, the AKK runtime and skill are loaded, the workspace is canonical, and the Gateway is healthy. Doctor does not make a credentialed model call.

## 3. Start one managed task

From any configured OpenClaw channel:

```text
/akk codex inspect this repository and summarize it
```

Use `/akk claude ...` or `/akk cursor ...` to override the configured default.

## 4. Continue it without copying an ID

```text
/akk send only: run the tests and explain any failures
```

`only` succeeds only when exactly one session is actionable. Otherwise AKK stops and lists stable short references instead of choosing a session.

## Boundary and recovery

Managed ACPX runs separately from the shared-terminal permission policy; tmux prompt inspection and AKK's exact-command `autoApprove` rules do not apply. Keep work inside the configured workspace. Use `/akk status only`, `/akk cancel only`, or `/akk recover only` when the task needs intervention.

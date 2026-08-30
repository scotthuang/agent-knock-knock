# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Agent Knock Knock lets **OpenClaw, Pi, or DeepSeek Harness** control Codex and Claude Code already running in **tmux or Herdr**. Watch work without staring at a remote terminal, send the next instruction from chat, and get callbacks when the coding agent finishes or needs attention.

AKK never launches a hidden replacement agent. The controller Host, the human, and AKK all use the same visible terminal and native coding-agent session.

**Stay in the terminal. Stay in control. No hooks. No agent-side plugins. No YOLO.**

## Install for OpenClaw

You need OpenClaw `2026.6.5`+, Node.js `22.19.0`+, and an authenticated `codex` or `claude` CLI running as the same OS user.

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

Start a shared coding-agent terminal in your project:

```bash
cd /absolute/path/to/project
tmux new-session -s akk-work -c "$(pwd -P)" codex
```

Use `claude` instead of `codex` if preferred. Herdr users can follow the [Herdr quick start](docs/quickstart-herdr.md).

In OpenClaw, first send:

```text
/akk doctor
```

After `AKK doctor: ready`, send a separate message:

```text
/akk inspect this repository and summarize it
```

That is the complete first-task flow. For terminal setup and multiple panes, see the [tmux quick start](docs/quickstart-tmux.md). Direct `/akk ...` commands need no OpenClaw tool-policy changes.

## Install for Pi

Pi can be the controller Host without OpenClaw. The current connector targets Pi `0.84.4`:

```bash
npm install -g @earendil-works/pi-coding-agent@0.84.4
pi install npm:@scotthuang/agent-knock-knock-pi@next
pi
```

Pi should show `AKK ready`. With Codex or Claude Code already running in tmux or Herdr, enter `/akk list`. The connector provides `/akk`, 16 structured tools, callbacks to the initiating Pi session, and native approval dialogs. See the [Pi connector guide](connectors/pi/README.md).

## Install for DeepSeek Harness

The connector supports DeepSeek Harness Web `0.1.1-rc.2` and `0.1.2-alpha.1`:

```bash
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
dsh web
```

Open a Web conversation and enter `/akk list`. The connector gives every conversation `/akk`, the same 16 structured tools, and callbacks to the exact Harness Agent that initiated the work. See the [DeepSeek Harness connector guide](connectors/deepseek-harness/README.md).

## See It in Action

[![AKK orchestrating a Claude Code-to-Codex handoff through tmux](https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/docs/assets/akk-tmux-handoff-demo.gif)](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/assets/akk-tmux-handoff-demo.mp4)

*OpenClaw asks Claude Code to write a file, waits for AKK to report completion, then hands the result to Codex. Both terminals remain available for direct human control. Click the preview for the full-quality video.*

## What AKK Gives You

Suppose several Codex or Claude Code jobs are already running in tmux or Herdr:

- **Watch without babysitting.** `/akk watch <terminal>` observes work already in progress and sends a callback when it finishes, needs approval, or becomes blocked. You can leave the terminal and continue from your phone or another chat client.
- **Send without typing in a tiny remote console.** `/akk <selector>: <message>` sends your natural-language instruction to the selected live coding-agent terminal. An explicit user Send has priority over stale AKK management state.
- **Inspect and recover.** `/akk status <turn-or-watch>` shows current state when a callback is delayed. Durable callback records and Watches provide a recovery path after transient Host failures.
- **Approve deliberately.** AKK can surface Codex or Claude Code permission requests and submit an explicit human decision. It preserves the coding agent's existing permission mode.
- **Hand control back and forth.** Attach to the same tmux or Herdr pane whenever you want. AKK does not create a parallel hidden conversation.

The common workflow is:

```text
/akk list
/akk watch <exact-terminal-id>
/akk codex: run the tests and explain any failures
/akk status <turn-id-or-watch-id>
```

Use identifiers and actions from a fresh `/akk list`; do not guess or cache terminal IDs.

## How It Works

```text
OpenClaw / Pi / DeepSeek Harness
              │
       AKK Host adapter
              │
   Session · Turn · Watch · Callback
              │
         tmux / Herdr
              │
      Codex / Claude Code
```

For a managed Send, AKK verifies the selected terminal and coding-agent process, writes one user request, monitors that exact Turn, and returns completion or attention callbacks to the initiating Host session. If stale AKK bookkeeping blocks an explicit Codex Send before terminal input, AKK can fall back to a verified one-time physical Send and attach a read-only Watch for callback and Status recovery.

AKK is local-first: there is no hosted control plane or telemetry. It stores only the local state needed for routing, lifecycle recovery, callback delivery, and idempotency.

## Compatibility

| Component | Supported boundary |
| --- | --- |
| Terminal hosts | tmux; local Herdr `0.8.0` protocol `19` |
| Coding agents | Codex and Claude Code; unknown complete versions are allowed with a compatibility warning and fail naturally if behavior changed |
| OpenClaw | `2026.6.5`+; plugin API and Gateway `2026.5.12`+ |
| Pi connector | Pi `0.84.4` |
| DeepSeek Harness connector | `0.1.1-rc.2` and `0.1.2-alpha.1` |
| Runtime | Node.js `22.19.0`+ on macOS or Linux |

The adjacent OpenClaw boundary `2026.5.10-beta.2` is intentionally unsupported. Herdr support is exact-version because its local control protocol is not yet a stable public API. See each connector guide for its tested release status and limitations.

## Documentation

Choose the guide that matches what you are trying to do:

| Guide | Use it for |
| --- | --- |
| [tmux quick start](docs/quickstart-tmux.md) | First OpenClaw task, multiple panes, and selectors |
| [Herdr quick start](docs/quickstart-herdr.md) | Local Herdr discovery and exact-version checks |
| [Pi connector](connectors/pi/README.md) | Pi installation, 16 tools, native approval, callbacks, upgrade, and uninstall |
| [DeepSeek Harness connector](connectors/deepseek-harness/README.md) | Harness installation, approval contract, callbacks, upgrade, and troubleshooting |
| [Operator guide](docs/operator-guide.md) | Complete command reference, reliable Send, Watch, Status, approval, recovery, Sessions, and native threads |
| [OpenClaw operations](docs/openclaw-operations.md) | npm alternative, configuration, auto-approval policy, supervisor behavior, and troubleshooting |
| [Host Bridge and Profiles](docs/host-bridge-profiles.md) | Connect another controller Host through MCP/stdio and a declarative Profile |
| [Terminal handoff protocol](docs/bidirectional-agent-protocol.md) | Identity, Turn lifecycle, callback guarantees, safety fences, and handoff semantics |
| [Storage and logging](docs/storage-and-logging.md) | State directories, permissions, protocol migration, logs, and privacy |
| [Testing](docs/testing.md) | Test tiers, architecture checks, and evidence workflows |
| [Contributing](CONTRIBUTING.md) | Local development and contribution workflow |

## Installation Alternatives

OpenClaw users who prefer npm can install the same core package directly:

```bash
npm install -g @scotthuang/agent-knock-knock
agent-knock-knock install-openclaw --verify
```

ClawHub remains the recommended OpenClaw path. Do not install both variants into the same OpenClaw profile.

To build the repository locally:

```bash
npm install
npm run build
npm run test:fast
```

Connector development uses `npm run pi:build` from the repository root, or `cd connectors/pi && npm run build`; DeepSeek Harness has the matching `npm run deepseek:build` script.

## Security and Privacy

AKK controls terminals, so treat installation as privileged local automation. Use an unprivileged OS account, restrict tmux and Herdr sockets, keep the state directory private, and review approval prompts before allowing input. AKK does not weaken Codex or Claude Code permissions, and model-facing tools never receive terminal-control tokens, callback credentials, Composer text, or approval fingerprints.

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/scotthuang/agent-knock-knock/security/advisories/new). Please do not include secrets, private terminal output, or credentials in a public issue.

## License

[MIT](LICENSE)

# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/scotthuang/agent-knock-knock/blob/main/LICENSE)

Agent Knock Knock lets **OpenClaw, Pi, or DeepSeek Harness** control existing **Codex Desktop conversations**, **Codex CLI shared-backend conversations**, and Codex or Claude Code running in **tmux or Herdr**. Discover conversations, send the next task from chat, and get callbacks when the coding agent finishes or needs attention.

AKK never launches a hidden replacement agent. The controller Host, the human, and AKK work in the same native conversation, through its original Desktop owner, CLI shared backend, or shared terminal.

**Stay in the terminal. Stay in control. No hooks. No agent-side plugins. No YOLO.**

## Install for OpenClaw

You need OpenClaw `2026.6.5`+, Node.js `22.19.0`+, and a supported Codex Desktop app or authenticated `codex` or `claude` CLI running as the same OS user.

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

For CLI agents, start a shared coding-agent terminal in your project:

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

That is the terminal first-task flow. For terminal setup and multiple panes, see the [tmux quick start](docs/quickstart-tmux.md). Direct `/akk ...` commands need no OpenClaw tool-policy changes. For Desktop, keep the intended conversation open in the supported app, ask OpenClaw to use AKK List, and select its Desktop row by title and project before sending a task. See the [Desktop guide](docs/codex-desktop-compatibility.md).

## Install for Pi

Pi can be the controller Host without OpenClaw. The current connector targets Pi `0.84.4`:

```bash
npm install -g @earendil-works/pi-coding-agent@0.84.4
pi install npm:@scotthuang/agent-knock-knock-pi@next
pi
```

Pi should show `AKK ready`. With Codex or Claude Code already running in tmux or Herdr, enter `/akk list`. The connector provides `/akk`, the complete capability-handshake-verified semantic tool catalog, the bundled `agent-knock-knock` skill, callbacks to the initiating Pi session, and native approval dialogs. See the [Pi connector guide](connectors/pi/README.md).

## Install for DeepSeek Harness

The connector supports DeepSeek Harness Web `0.1.1-rc.2`, `0.1.2-alpha.1`, and
`0.1.5-rc.2`:

```bash
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
dsh web
```

Open a Web conversation and enter `/akk list`. The connector gives every conversation `/akk`, the same capability-handshake-verified semantic tool catalog, the bundled `agent-knock-knock` skill, and callbacks to the exact Harness Agent that initiated the work. See the [DeepSeek Harness connector guide](connectors/deepseek-harness/README.md).

## See It in Action

[![AKK orchestrating a Claude Code-to-Codex handoff through tmux](https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/docs/assets/akk-tmux-handoff-demo.gif)](https://github.com/scotthuang/agent-knock-knock/blob/main/docs/assets/akk-tmux-handoff-demo.mp4)

*OpenClaw asks Claude Code to write a file, waits for AKK to report completion, then hands the result to Codex. Both terminals remain available for direct human control. Click the preview for the full-quality video.*

## What AKK Gives You

AKK 0.14 adds Codex Desktop discovery, task sending, Status, and exact task Watches. List includes Desktop catalog candidates even when the app has unloaded their live owner; only a freshly verified live conversation can receive a task. Desktop approval and question answering remain manual in this first version. See [Desktop compatibility and usage](docs/codex-desktop-compatibility.md).

Codex CLI sessions connected to a shared backend can also be controlled directly, without tmux or Herdr. Native CLI rows support task sending, exact Watch and callbacks, command/file approvals, blocking and asynchronous answers, and per-thread permission settings. See the [CLI shared-backend guide](docs/codex-cli-native-compatibility.md).

The existing terminal workflows remain available for Codex or Claude Code running in tmux or Herdr:

Codex CLI 0.158.0/0.159.0/0.159.2/0.159.3/0.160.0 supports exact paginated task Watches for ordinary terminal
Send, native question responses, and durable completion callbacks. The adapter
checks the foreground thread and server version before attaching; uncertain
answers are never automatically replayed. See the [0.158.0/0.159.0/0.159.2/0.159.3/0.160.0 compatibility
review](docs/codex-0.160.0-compatibility.md) for managed-session and already-open
question boundaries. Codex 0.157.x retains its [partial compatibility](docs/codex-0.157.1-compatibility.md).

- **Watch without babysitting.** `/akk watch <terminal>` observes work already in progress and sends a callback when it finishes, needs approval, or becomes blocked. You can leave the terminal and continue from your phone or another chat client.
- **Send without typing in a tiny remote console.** `/akk <selector>: <message>` sends your natural-language instruction to the selected live coding-agent terminal. An explicit user Send has priority over stale AKK management state.
- **Identify an ambiguous Codex foreground explicitly.** When several rollout files or a recent `/clear` prevent durable attribution, an advertised foreground-identification action can inspect one exact idle pane without guessing which rollout is current.
- **Set Codex permissions before a task.** `/akk permissions <exact-terminal-id>` reads the current setting and native choices; `/akk set-permissions <exact-terminal-id> <advertised-mode-id>` applies your selected mode to that idle session and verifies it before Send. Full Access works like the other options; AKK handles its native confirmation automatically without an extra user prompt. See [Codex permissions](docs/codex-permissions.md).
- **Switch models through the native catalog.** `/akk models <exact-terminal-id>` lists the choices currently offered by one exact physical Codex or Claude Code pane; a Codex rollout/native-thread attribution is not required, so this also works before the first rollout materializes. `/akk set-model ...` consumes one exact advertised model/reasoning-effort tuple without accepting raw slash commands, keys, or menu indexes. Codex synchronizes the model and ordinary efforts through `max` to the current and future-session defaults; its `ultra` effort is current-session-only, and the native UI does not expose the exact non-Ultra effort chosen for future sessions, so AKK omits that unobservable field. Claude Code changes only the current session.
- **Continue or clear only a proven model-control residue.** If a failed profiled Codex 0.154.0/0.155.1 model-control attempt leaves an exact `/model` completion surface or bare `/model` Composer, a fresh List may advertise both `/akk models <exact-terminal-id>` and `/akk repair-model-control <exact-terminal-id>`. Models uses a separate residual-bound authority to continue that exact native slash command into read-only catalog discovery without retyping it. If the exact native picker is already open, List marks the pane non-idle and advertises repair only. Repair remains the cleanup-only escape hatch, never presses Enter, and must prove an empty Composer.
- **Inspect and recover.** `/akk status <turn-or-watch>` shows current state when a callback is delayed. Durable callback records and Watches provide a recovery path after transient Host failures.
- **Approve deliberately in supported terminals.** AKK can surface Codex or Claude Code permission requests and submit an explicit human decision. It preserves the coding agent's existing permission mode. Desktop v1 only notifies you to handle questions and approvals in the app.
- **Hand control back and forth.** Attach to the same tmux or Herdr pane whenever you want. AKK does not create a parallel hidden conversation.

The common workflow is:

```text
/akk list
/akk watch <exact-terminal-id>
/akk models <exact-terminal-id>
/akk set-model <exact-terminal-id> <advertised-model-id> <advertised-reasoning-effort>
/akk codex: run the tests and explain any failures
/akk status <turn-id-or-watch-id>
```

If List advertises `repair-model-control`, it is an alternative cleanup flow:

```text
/akk repair-model-control <exact-terminal-id>
/akk list
/akk models <exact-terminal-id>
/akk set-model <exact-terminal-id> <advertised-model-id> <advertised-reasoning-effort>
```

Use identifiers and actions from a fresh `/akk list`; do not guess or cache terminal IDs. Model switching is fail-closed: the same exact physical pane/process must still be free of an active Turn or any input-owning approval, questionnaire/editor, or read-only viewer, and must show either an exact idle empty Composer or one stable profiled Codex 0.154.0/0.155.1 `/model` residual. A profiled Codex 0.154.0/0.155.1 zero-rollout pane does not require `identify_foreground` or a resolved native rollout identity; Claude Code still requires its exact current native Session. When List advertises both actions for a Composer residual, `model_options` may continue it into the catalog while `repair_model_control` only clears it. An open exact picker is non-idle and exposes repair only. If continuation, repair, or model switching reports `uncertain`, inspect the pane instead of retrying automatically.

## How It Works

```text
OpenClaw / Pi / DeepSeek Harness
              │
       AKK Host adapter
              │
   Session · Turn · Watch · Callback
              │
     ┌────────┴───────────────┐
 tmux / Herdr         Codex Desktop IPC
     │                       │
 Codex / Claude Code  Original Desktop thread
```

For a managed Send, AKK verifies the selected terminal and coding-agent process, writes one user request, monitors that exact Turn, and returns completion or attention callbacks to the initiating Host session. If stale AKK bookkeeping blocks an explicit Codex Send before terminal input, AKK can fall back to a verified one-time physical Send and attach a task Watch for callback and Status recovery.

Desktop uses a separate adapter. It combines a read-only catalog with live owner discovery, verifies the exact thread, submits at most once, and records the accepted native task for monitoring. It does not start a CLI to replay Desktop history. An uncertain submission is reconciled from native evidence and never automatically resent.

Native Pi and DeepSeek Harness connectors accept the shared catalog through a
versioned, secretless Host Adapter capability handshake. Startup verifies the
ordered semantic tool registration and the bundled Skill against catalog and
Skill SHA-256 digests; an older, missing, or drifted handshake fails closed
instead of mounting a partial tool surface. Connector package versions remain
independent of one another.

In the current OpenClaw plugin and core Host Adapter, an idle Codex pane with ambiguous foreground rollout identity may advertise `identify_foreground`. That action issues one closed `/status` command to the exact pane. It does not mutate the AKK Store, but it does type into the visible terminal. Its 30-second result is diagnostic only and grants no later authority. The separate `identify_and_send` action keeps one terminal lock across the probe and one requested task, then relies on exact request acceptance—not the status card—for durable Session and Turn identity. List and Status never run this probe. Codex 0.158.0/0.159.0/0.159.2/0.159.3/0.160.0 exact Send and active-task Watch use a separate closed `/status` transaction to bind the foreground paginated thread; subsequent observation is read-only.

AKK is local-first: there is no hosted control plane or telemetry. It stores only the local state needed for routing, lifecycle recovery, callback delivery, and idempotency.

## Compatibility

| Component | Supported boundary |
| --- | --- |
| Terminal hosts | tmux; local Herdr `0.8.0` protocol `19` |
| Codex Desktop | macOS `26.1002.52244`, build `13536`; local existing conversations via private IPC; send, status, and exact Watch only |
| Codex CLI shared backend | Verified CLI `0.160.0` + app-server `0.162.0`; loaded main CLI threads, with live protocol checks |
| Coding agents | Codex and Claude Code; unknown complete versions are allowed with a compatibility warning and fail naturally if behavior changed |
| OpenClaw | `2026.6.5`+; plugin API and Gateway `2026.5.12`+ |
| Pi connector | Pi `0.84.4` |
| DeepSeek Harness connector | `0.1.1-rc.2`, `0.1.2-alpha.1`, and `0.1.5-rc.2` |
| Runtime | Node.js `22.19.0`+ on macOS or Linux |

The adjacent OpenClaw boundary `2026.5.10-beta.2` is intentionally unsupported. Herdr and Desktop controls depend on reviewed private protocol versions. Desktop catalog presence alone does not prove the conversation is open or controllable. See each connector guide and the Desktop guide for tested boundaries and limitations.

## Documentation

Choose the guide that matches what you are trying to do:

| Guide | Use it for |
| --- | --- |
| [tmux quick start](docs/quickstart-tmux.md) | First OpenClaw task, multiple panes, and selectors |
| [Herdr quick start](docs/quickstart-herdr.md) | Local Herdr discovery and exact-version checks |
| [Codex Desktop](docs/codex-desktop-compatibility.md) | Discover existing Desktop conversations, send once, monitor exact tasks, and handle manual attention |
| [Pi connector](connectors/pi/README.md) | Pi installation, semantic tool catalog, bundled skill, native approval, callbacks, upgrade, and uninstall |
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

AKK controls local coding-agent sessions, so treat installation as privileged local automation. Use an unprivileged OS account, restrict tmux, Herdr, and Desktop IPC sockets, keep the state directory private, and review approval prompts before allowing input. Ordinary AKK Send does not change agent permissions. Desktop tasks inherit that conversation's current settings; handle its questions and approvals manually. The explicit terminal Codex permission tool applies only the user-selected native mode; model-facing tools never receive terminal-control tokens, callback credentials, Composer text, or approval fingerprints.

Report vulnerabilities privately using [GitHub Security Advisories](https://github.com/scotthuang/agent-knock-knock/security/advisories/new). Please do not include secrets, private terminal output, or credentials in a public issue.

## License

[MIT](LICENSE)

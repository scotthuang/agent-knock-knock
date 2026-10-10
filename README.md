# Agent Knock Knock (AKK)

[![npm](https://img.shields.io/npm/v/%40scotthuang%2Fagent-knock-knock)](https://www.npmjs.com/package/@scotthuang/agent-knock-knock)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Let your agent orchestrate the coding conversations you already use.**
AKK lets a controller such as OpenClaw discover your conversations, send tasks,
and receive completion or question notifications while you stay in chat.

**Codex CLI shared-backend connections and Codex Desktop work without tmux or
Herdr.** AKK controls the original conversation, so you see the same work in
Codex. Claude Code and applicable Codex terminal workflows use tmux or Herdr.
AKK does not launch a hidden replacement agent.

AKK 0.14.0 introduces Codex CLI shared-backend control, Codex Desktop support,
unified conversation routing, and exact-task recovery. **0.14.1 adds bounded
public progress in Status and shared 12-hour monitoring defaults.** See the
[release notes](CHANGELOG.md#0141---2026-10-10) for changes and validation limits.

## What you can do

- **Find and select conversations** by project and title. Desktop also lists
  saved sidebar entries that are not connected; those rows cannot receive tasks.
- **Send and follow an exact task**, or Watch work you started yourself.
  Results and attention notifications return to the initiating controller.
- **Answer supported questions, approve requests, and set permissions** through
  the selected provider's advertised actions. Desktop also supports explicit
  model settings and exact task cancellation.
- **Recover monitoring and callback failures** without resending the task.
  [Backend Recovery](docs/backend-task-recovery.md) distinguishes Recover,
  Renew, Close, Unwatch, and Retry Callback.

## Quick start with OpenClaw

Use Node.js `22.19.0`+, OpenClaw `2026.6.5`+, and an authenticated coding agent
under the same OS user as AKK.

### 1. Install AKK

Use ClawHub for the OpenClaw plugin, including the 0.14 backend and Desktop
features:

```bash
openclaw plugins install clawhub:@scotthuang/agent-knock-knock
openclaw gateway restart
```

The [installation guide](docs/openclaw-operations.md#choose-one-installation-path)
also covers npm. Building a reviewed checkout is optional; see
[local development installation](docs/openclaw-operations.md#local-development-build).
Choose one installation path per OpenClaw profile.

### 2. Make your conversation available

- **Codex CLI direct:** keep a main CLI conversation connected to a reachable
  local shared backend. No terminal container is required. An embedded backend
  or unloaded history is not a direct-control target; see the
  [CLI guide](docs/codex-cli-native-compatibility.md).
- **Codex Desktop:** open the intended local conversation in the reviewed app
  build. A saved conversation with no verified live owner must be opened in
  Desktop before AKK can send to it. See the [Desktop guide](docs/codex-desktop-compatibility.md).
- **Claude Code or Codex terminal control:** follow the [tmux](docs/quickstart-tmux.md)
  or [Herdr](docs/quickstart-herdr.md) quick start, including `/akk doctor`.

### 3. List, select, and send

In your OpenClaw chat, send:

```text
/akk list
```

Then send a separate message asking OpenClaw to use the listed conversation:

```text
Use AKK to send “Summarize this project's test setup” to the Codex conversation
for my-project, and tell me when that task finishes.
```

If several rows match, select the exact listed conversation. The controller
uses its returned ID and available Send action; you do not need to choose a
transport. Enable [natural-language tool routing](docs/openclaw-operations.md#optional-natural-language-routing)
if your OpenClaw tool policy restricts AKK. Direct `/akk ...` commands do not
require that policy change.

Keep the returned task/Watch ID to query `/akk status <id>` later. To observe
work already running, ask OpenClaw to Watch that listed conversation. A
callback accepted by OpenClaw does not itself prove delivery to WeChat or
another downstream channel.

## Compatibility at a glance

These are distinct provider boundaries, not a blanket minimum Codex version.

| Connection | Requirements and verified scope |
| --- | --- |
| **Codex CLI direct** | Loaded main CLI thread on a compatible local shared backend. Live-tested on **macOS: CLI 0.160.0 + app-server 0.162.0**. Runtime identity/protocol checks determine availability; no numeric minimum has been established. |
| **Codex Desktop** | Verified **macOS app 26.1002.52244, build 13536**, bundle `com.openai.codex` at `/Applications/ChatGPT.app`. Native writes require that **exact version/build** and a verified live owner. |
| **Codex / Claude Code terminals** | tmux or local Herdr **0.8.0 / protocol 19**. Reviewed Codex TUI profiles include **0.160.0**; Claude Code **2.1.285** was verified on macOS arm64. Operations depend on the agent version and current UI. |
| **OpenClaw / runtime** | OpenClaw **2026.6.5+**, plugin API/Gateway **2026.5.12+**; Node.js **22.19.0+**. Core terminal support targets macOS/Linux; the Desktop profile is macOS-only. |

Additional targeted verification on 2026-10-10 used **CLI 0.162.1 + backend
0.162.1** for public Status progress, 12-hour Send monitoring and an isolated
completion callback. Other native capabilities were not repeated in that run.
Frontend and backend versions need not match. The [CLI evidence](docs/codex-cli-native-compatibility.md#compatibility-and-limits)
and [Desktop profile](docs/codex-desktop-compatibility.md#version-and-platform-evidence)
separate current observations, tested operations, and unsupported cases.

Direct CLI currently lacks model control, cancellation, and native new/resume
operations. Some can use a verified terminal capability; others, including
paginated Codex new/resume, remain unsupported. Desktop has no terminal fallback
and cannot create or cold-load conversations. Backend busy/blocked states or
uncertain execution never trigger a retry through another transport. See
[routing and operation limits](docs/codex-cli-native-compatibility.md#automatic-conversation-routing-2026-10-10).

## Other controller Hosts

[Pi](connectors/pi/README.md) and [DeepSeek Harness](connectors/deepseek-harness/README.md)
have independent connector packages and installation guides. Their current
package manifests pin AKK **0.13.3**; their published capabilities must not be
inferred from this 0.14 README. See each guide for its reviewed
Host versions, callbacks, and upgrade procedure.

## Documentation

| Guide | What it covers |
| --- | --- |
| [CLI direct control](docs/codex-cli-native-compatibility.md) | Discovery, sending, Watch, interactions, routing, and version evidence |
| [Codex Desktop](docs/codex-desktop-compatibility.md) | Sidebar discovery, live-owner requirements, native controls, and tested build |
| [Backend Recovery](docs/backend-task-recovery.md) | Exact-task recovery, renewal, Close versus Unwatch, and callback retry |
| [tmux](docs/quickstart-tmux.md) · [Herdr](docs/quickstart-herdr.md) | Terminal setup and the first task |
| [Operator guide](docs/operator-guide.md) | Command reference, terminal models/lifecycle, identity, and advanced controls |
| [OpenClaw operations](docs/openclaw-operations.md) | Installation, tool policy, configuration, and troubleshooting |
| [Codex permissions](docs/codex-permissions.md) | Terminal permission choices and verification |
| [Host Bridge](docs/host-bridge-profiles.md) | Connect another controller through MCP/stdio and a Host Profile |
| [Storage and logging](docs/storage-and-logging.md) | Local state, privacy, logs, and protocol migration |
| [Testing](docs/testing.md) · [Contributing](CONTRIBUTING.md) | Development checks and contribution workflow |

AKK runs locally, with no hosted control plane or telemetry. Send preserves the
agent's permissions; explicit settings and approval actions apply the user's
choice. Keep local control sockets and AKK state private. Report vulnerabilities
through [GitHub Security Advisories](https://github.com/scotthuang/agent-knock-knock/security/advisories/new).

[MIT license](LICENSE).

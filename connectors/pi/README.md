# Agent Knock Knock for Pi — POC

This package makes Pi the orchestration Host for Agent Knock Knock. Pi can use
`/akk` and AKK's semantic tools to control existing Codex and Claude Code
terminals discovered through tmux or Herdr.

The connector is a Pi Extension. It does not modify Pi, launch coding agents,
or depend on an OpenClaw Gateway.

## POC scope

- Pi 0.84.4 and Node.js 22.19 or newer.
- `/akk` plus all 16 HostAdapter tools.
- List, Send, Status, Watch, Respond, Approve and Cancel paths.
- Route-bound `command_json_v1` callbacks over an authenticated local Unix
  socket.
- A Pi-native confirmation gate before a model-facing approval mutation.
- One live Pi runtime and branch epoch. Session replacement or explicit tree
  navigation invalidates the previous route rather than migrating callbacks.

AKK keeps the target coding agent's existing permission mode. This POC does
not enable `--yolo` and does not expose AKK's OpenClaw-specific `autoApprove`
configuration.

## Local development load

Build the package, then load the local Extension for one Pi run:

```sh
npm run build
pi -e /absolute/path/to/agent-knock-knock/connectors/pi
```

For a persistent local-path installation:

```sh
pi install /absolute/path/to/agent-knock-knock/connectors/pi
```

No npm publication is required for either workflow.

The POC rejects any Pi runtime other than 0.84.4 before it creates a socket or
starts AKK lifecycle work. Pi's own packages remain `*` peer dependencies, as
required by Pi's package contract; the runtime check is the compatibility
authority.

For an isolated development Store, set `AKK_PI_STORE_DIR` to an absolute
directory before starting Pi. If omitted, AKK uses its normal shared Store.
`AKK_PI_STATE_DIR` can similarly override the Connector callback-inbox
directory. Neither variable carries callback credentials.

## Approval behavior

An approval callback is queued into the originating Pi session. Before the
`agent_knock_knock_approve` tool mutates a terminal, the connector refreshes
AKK Status and requires an explicit Pi UI selection.

- **Approve once** executes the current prompt-scoped AKK approval.
- **Keep pending** sends no terminal input.
- For a managed `turn_id`, **Reject and cancel task** requires a second
  confirmation and invokes AKK Cancel.

A terminal-scoped approval does not imply terminal-scoped Cancel authority, so
its dialog intentionally offers only Approve or Keep pending. A separately
advertised AKK Cancel action still uses its own Pi confirmation dialog.

AKK currently has no generic "press the target's No choice but continue the
Turn" tool. Respond answers ordinary questions; it is not an approval denial.

## Reliability boundary

AKK's callback acknowledgement means the connector durably admitted the
callback to its local inbox. Pi 0.84.4 does not return a model-consumption
receipt from `sendMessage()`, so the acknowledgement does not prove that the
model has already processed the callback.

The POC intentionally does not provide a standalone Supervisor, multi-Host
leader election, cross-session callback migration, or remote terminal access.
The durable inbox does not migrate old random controller identities into a new
Pi runtime after a crash; recovery in this POC is Status/Watch from the new
runtime. Also, because Pi marks a synchronous `sendMessage()` invocation
without an asynchronous consumption receipt, a crash after that call can
produce an at-least-once or uncertain final hop.

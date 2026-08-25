# Host Bridge and Host Profiles

The AKK Host Bridge lets a compatible controller Host use AKK without
forking this repository. The Host starts one foreground MCP/stdio process,
binds it to its trusted current session, and owns that process for the whole
integration lifetime.

```text
controller Host
└─ foreground AKK Host Bridge (MCP over stdio)
   ├─ the existing 16 semantic AKK tools
   ├─ one startup-selected Host Profile v1
   ├─ Host-owned monitor and Terminal Watch lifecycle
   └─ the existing Session, Turn, Store, callback, and terminal core
```

The Bridge is an adapter around the existing tool and state model, not a
second implementation. The OpenClaw native plugin remains unchanged and does
not route its callbacks through `command_json_v1`.

## Choose an integration level

AKK defines three integration levels:

1. **Bundled Profile.** AKK can ship a reviewed Profile for a common Host. A
   user selects its reserved ID and writes no integration code. The registry
   is currently empty, so this repository does not yet claim a bundled Host
   Profile; `agent-knock-knock host-profile list` is authoritative.
2. **User Profile.** A compatible Host uses a local JSON file such as
   [`command-json-starter.json`](../examples/host-profiles/command-json-starter.json).
   This needs no AKK fork, production-code change, or upstream pull request.
3. **External thin connector.** If the Host cannot satisfy the v1 drivers, a
   separate Host-specific package translates its API at the stable Bridge
   boundary. This requires programming, but it still does not fork or copy
   AKK core.

A level-3 connector owns two small edges: it starts AKK's MCP/stdio Bridge and
maps the Host's tool API to that MCP client; it also exposes a non-shell
callback executable that reads the body from stdin, injects it into the exact
Host session, and returns the exact delivery/message acknowledgement JSON.
The connector remains an external package and does not implement AKK's tools,
Store, Turn, Watch, or callback-outbox state machine.

Configuration-only integration at level 1 or 2 requires all of the following:

- The Host can launch and own a foreground MCP server over stdio, keeping the
  child's stdout exclusively for MCP messages.
- The Host can put the trusted current session ID in a named child-process
  environment variable. It must not obtain that identity from a model tool
  argument.
- The Host has an absolute executable that can inject a callback body into
  that exact session without a shell.
- That executable accepts the exact AKK delivery and message IDs and emits a
  bounded JSON acknowledgement that echoes both IDs.
- Any callback credentials can be supplied in the Host process environment
  and named in a narrow Profile allowlist.

If one of those conditions is impossible—for example, the Host exposes only a
custom authenticated RPC API, cannot act as an MCP client, or cannot return an
exact acknowledgement—use an external thin connector. A Profile does not load
arbitrary JavaScript or native adapter code.

## Start from the example

Create the packaged starter Profile and change its Host identity, executable,
argument shape, environment names, and acknowledgement pointers:

```sh
agent-knock-knock host-profile example > ./my-agent.json
```

This command works from a normal npm/global installation; a source checkout is
not required.

The example assumes Host `my-agent` version `1.8.0`, controller session
environment variable `MY_AGENT_SESSION_ID`, and callback credential
`MY_AGENT_TOKEN`. It also explicitly forwards `PATH` because npm-installed
command shims commonly use `#!/usr/bin/env node`. Validate both the document
and its Host compatibility:

```sh
agent-knock-knock host-profile validate ./my-agent.json \
  --host my-agent \
  --host-version 1.8.0
```

`--host` and `--host-version` must be supplied together when compatibility is
checked. The Bridge and Host Profile doctor always require both. Run the doctor
from the same trusted Host environment that will launch the Bridge:

```sh
MY_AGENT_SESSION_ID='trusted-session-id' \
MY_AGENT_TOKEN='credential-from-host-runtime' \
agent-knock-knock doctor \
  --host-profile ./my-agent.json \
  --host my-agent \
  --host-version 1.8.0
```

The doctor checks Profile parsing, exact Host/version compatibility, trusted
session resolution, and whether the callback path and resolved symlink target
are an executable, non-shell regular file. It does not send a callback.

The Host then launches this exact long-running command as its MCP/stdio server:

```sh
MY_AGENT_SESSION_ID='trusted-session-id' \
MY_AGENT_TOKEN='credential-from-host-runtime' \
agent-knock-knock host-bridge \
  --profile /absolute/path/to/my-agent.json \
  --host my-agent \
  --host-version 1.8.0
```

Use an absolute Profile path in the Host's server configuration unless that
configuration also fixes the child working directory; relative paths are
resolved from the Bridge process working directory.

In production, the Host's process configuration should inject those
environment values rather than placing credentials in a checked-in script.
The optional `--store-dir <dir>` selects the normal AKK Store location. The
Profile is selected once when the process starts; it is not a model-visible
tool parameter.

Use the following command to inspect built-in availability independently of
local files:

```sh
agent-knock-knock host-profile list
```

## Host Profile v1 reference

The packaged, editor-readable structural contract is
[`schemas/host-profile-v1.schema.json`](../schemas/host-profile-v1.schema.json).
Its resolvable raw-GitHub `$id` is also the value used by starter Profiles.
`host-profile validate` remains the authoritative semantic validator for
constraints JSON Schema cannot express directly, such as requiring one
arbitrary mapping value to mean `accepted`, requiring two configured JSON
Pointers to differ, and the complete normalized-path/aggregate-argv checks.
Runtime parsing is strict and fail-closed: every object rejects unknown fields,
unsupported versions are rejected, strings and arrays are bounded, and user
Profiles cannot use the reserved `builtin-` namespace or replace a registered
built-in ID. A Profile is administrator-controlled, code-equivalent
configuration because it selects an executable.

Top-level fields have these meanings:

| Field | Meaning |
| --- | --- |
| `$schema` | Recommended editor/schema hint. If present, it must be the exact v1 schema URL. |
| `schema`, `version` | Exact protocol identity: `agent-knock-knock/host-profile`, version `1`. |
| `id`, `revision` | Stable Profile identity and administrator-controlled revision. |
| `compatibility` | Exact Host ID plus one to four explicit SemVer comparators, such as `>=1.8.0 <2.0.0`. |
| `controllerContext` | Trusted controller-session resolver and binding scope; v1 supports only `environment_v1`. |
| `callback` | Callback delivery configuration; v1 supports only `command_json_v1`. |

The command-line Host ID must exactly equal `compatibility.host`, and its
`--host-version` must be an exact SemVer version satisfying every comparator
in `compatibility.range`. Changing the selected file after Bridge startup
causes child operations to fail closed on its captured fingerprint; update the
revision when appropriate and restart the Bridge deliberately.

### `environment_v1`

```json
{
  "driver": "environment_v1",
  "sessionIdVariable": "MY_AGENT_SESSION_ID",
  "scope": "startup_v1"
}
```

`sessionIdVariable` names the environment variable from which the Bridge reads
the trusted controller session at startup. The variable name must be uppercase
and safe. Dynamic-loader and shell startup variables such as `DYLD_*`,
`LD_PRELOAD`, `NODE_OPTIONS`, and `BASH_ENV` are rejected. The resolved session
is captured into AKK's private callback route; the model cannot provide or
override it. Names beginning `AKK_HOST_PROFILE_` are reserved for the private
Bridge relay and cannot be used as session or callback allowlist variables.

`scope` is optional. When omitted, its effective value is `startup_v1`, which
preserves the original Host Profile v1 document and fingerprint behavior.
`startup_v1` binds every callback to the one trusted controller session
captured when the Host Bridge starts; callback delivery requires the persisted
route to match that session exactly.

`route_bound_v1` is an extension point for a Host-native thin connector that
serves multiple Host sessions in one process. Profile identity, revision,
transport, and fingerprint remain trusted and exact, but
`${controller.session_id}` is populated from the immutable controller session
already persisted in each callback route. It is never taken from a callback
tool argument. The generic MCP/stdio `host-bridge` command deliberately rejects
this scope because that standalone Bridge owns exactly one startup session.
Use `host-profile validate` to inspect `standalone_bridge_compatible`;
`doctor --host-profile` reports an explicit `standalone_bridge_scope` error for
a route-bound Profile.

Long-lived work such as Terminal Watch captures the complete route (Profile
identity, revision, transport, and controller session) when the user creates
the Watch. A later shared lifecycle pass may deliver that route, but must not
rebuild it from the lifecycle process's current Profile. After a native Host
restart, a new Profile revision therefore fails closed instead of adopting an
old Watch or routing it to a replacement Agent.

### `command_json_v1`

`command_json_v1` starts `callback.executable` directly with an argv array and
`shell: false`. The executable must be a normalized absolute path to a
non-shell program. It must be present and executable before the Bridge starts.

The argv templates support only these placeholders:

| Placeholder | Value | Allowed destination |
| --- | --- | --- |
| `${controller.session_id}` | Startup-trusted session, or the persisted route session for `route_bound_v1` | argv |
| `${envelope.delivery_id}` | Exact callback delivery ID | argv |
| `${envelope.message_id}` | Exact callback event/message ID | argv |
| `${envelope.idempotency_key}` | Stable logical-delivery deduplication key | argv |
| `${envelope.body}` | User-facing callback message body | stdin only |

The arguments must include the session, delivery, and message placeholders.
The idempotency placeholder is optional for Hosts whose callback CLI supports
an explicit deduplication key, and is strongly recommended when available.
Arbitrary environment expansion, command substitution, shell syntax, malformed
interpolation, and putting the callback body in argv are rejected. The `stdin`
field must be exactly `${envelope.body}`: the callback process receives the
event body text on stdin, not a serialized callback envelope.

`callback.environment.allow` is the complete pass-through allowlist for the
callback child. Only variables both named there and present in the Bridge
environment are forwarded. Unlisted variables are omitted; unsafe shell and
dynamic-loader variables cannot be allowlisted. Keep secrets out of the
Profile itself and list only the credential names the callback executable
actually needs.

If the executable starts with a `/usr/bin/env` shebang, `PATH` must be in the
allowlist so the interpreter can be resolved; doctor reports an error when it
is missing. This intentionally widens interpreter lookup, so prefer a native
binary or an absolute interpreter shebang and remove `PATH` when the Host CLI
supports that form.

Both execution limits are mandatory. `timeoutMs` is an integer from 1 through
30,000. `maxOutputBytes` is an integer from 1 through 1,048,576 and bounds
captured process output. The starter uses 8 seconds and 64 KiB.

### Exact acknowledgement

The callback executable writes one JSON document to stdout. The Profile uses
JSON Pointers to find its disposition, acceptance ID, acknowledged delivery
ID, and acknowledged message ID. For the starter Profile, an accepted result
looks like this:

```json
{
  "result": {
    "status": "accepted",
    "acceptance_id": "my-agent-acceptance-42"
  },
  "request": {
    "delivery_id": "the-exact-akk-delivery-id",
    "message_id": "the-exact-akk-message-id"
  }
}
```

The host-specific value at `disposition.jsonPointer` is translated through
`mapping` into exactly one generic outcome:

| Generic outcome | Meaning |
| --- | --- |
| `accepted` | The Host accepted the exact callback. A non-empty acceptance ID and exact echoed delivery/message IDs are required. |
| `retryable_failure` | The Host explicitly says a later delivery attempt may succeed. |
| `permanent_failure` | The Host explicitly rejects the delivery permanently. |
| `uncertain` | A side effect may have occurred, but exact acceptance is not proven. |

Every mapped acknowledgement must echo the exact delivery and message IDs.
An unknown mapping value, malformed or missing JSON, mismatched IDs, timeout,
or output-limit failure cannot be upgraded to success. A timeout or invalid
acknowledgement after a possible side effect is classified as uncertain and is
not blindly retried. This preserves the existing callback outbox's recovery,
lease, deduplication, and settlement behavior.

## Trust boundary

The Host Profile, Host ID/version, trusted session, executable, argv,
credentials, environment allowlist, acknowledgement rules, and Profile
selection all belong to the administrator/Host boundary. None is accepted from
the 16 model-facing semantic tool calls. MCP inputs are validated against the
existing closed tool schemas before the shared tool implementation runs.

The Bridge or Host-native connector privately passes a fingerprinted Profile
selection and route to its AKK CLI and monitor children. The Store receives
only the immutable callback route/envelope data required by the existing
callback contract; it does not
persist arbitrary callback commands or credential values. Callback stdout is
interpreted only through the configured bounded pointers and is not treated as
new executable configuration.

Logs go to stderr so stdout remains an MCP protocol stream. Do not wrap the
Bridge or callback command in a shell, and do not let a model edit the selected
Profile or the Host process environment.

## Lifecycle and shutdown

After MCP connects, the Bridge runs the shared Host-owned lifecycle: one
startup reconciliation followed by non-overlapping periodic sweeps for managed
Turn monitors and Terminal Watches. The two phases have independent error
boundaries, so one phase failure does not suppress the other.

The Bridge remains a foreground child owned by one Host. Closing its stdin or
sending `SIGINT`/`SIGTERM` stops new MCP work, cancels future lifecycle sweeps,
drains in-flight lifecycle and accepted tool work, and exits. The Bridge does
not daemonize, install a service, elect a supervisor, coordinate multiple
Hosts, or move pending work from one Host to another.

AKK may still run the existing per-Turn monitor worker processes used by its
core task lifecycle. Those workers are task workers, not a standalone Bridge
supervisor. Callback delivery requires the configured Host callback executable
and its receiving Host session to be available; the v1 design does not promise
Watch or callback continuity after the owning Host exits.

OpenClaw continues to use its native in-process adapter, callback transport,
and lifecycle registration exactly as before. Existing OpenClaw users do not
need a Host Profile, a callback command, or an MCP/stdio Bridge migration.

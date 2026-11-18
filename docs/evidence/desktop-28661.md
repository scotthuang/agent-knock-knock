# Desktop 28661 compatibility evidence — AKK 0.16.17

## Scope and source

macOS application 26.1111.71025 / build 28661, bundle identity
`com.openai.codex`. Product adaptation commit: `aae3434034bb0b6cd4fb0b271975ec7c1da58f79`.

- `src/desktop-sidebar-metadata.ts`: select the exact active owner's atom bank,
  preserve Desktop's current-atom precedence, and scope migrated pins/root hints.
- `src/desktop-ipc-client.ts`: accept reviewed snapshot streams 11 and 13 with
  unchanged exact peer/thread/revision/history/request/item validation.
- Synthetic regressions retain legacy storage, isolate accounts, reject invalid
  owner/schema versions and exercise both supported stream envelopes.

## Real native observation, 2026-11-18

Only the user's dedicated test conversation was used. Original directory,
model and permissions were preserved. No UI typing, replacement CLI or new
conversation was used.

The first task was accepted and failed natively. Necessary native log excerpts
(account identifiers, paths and task IDs omitted):

```text
16:23:25 +08:00 error code=-32603 message="workspace routing discovery timed out"
16:23:25 +08:00 errorMessage="Timed out waiting for MCP response to account/read"
16:24:00 +08:00 method=account/read errorCode=-32603 durationMs=34805 queueWaitMs=0
17:01:32 +08:00 method=get routePattern=/wham/usage errorMessage="Workspace routing is unavailable" status=432
17:01:53 +08:00 original AKK diagnostic task submitted once
```

The installed main-process code wraps account-route discovery failure locally
as status 432 before the usage fetch; that status is not evidence of a remote
HTTP 432 response. The same failure predates the AKK Send. The user subsequently
confirmed the proxy was off and enabling it restored operation. No controlled
network-setting experiment was performed by AKK.

The unchanged candidate's formal semantic tool/CLI entry then submitted one new
fixed-reply task, explicitly prohibiting tools, files and commands:

```text
17:39:37 +08:00 new Send; acceptance initially unproven; no resend
17:39:40 +08:00 original Watch verifies exact new native turn
17:39:49 +08:00 exact task completed; fixed reply matched
local callback accepted; attempts=1; notification count=1
final readback: same thread/cwd/model/permissions; idle; send available
```

No private reasoning, token, owner fingerprint, real task ID or user conversation
content is included here. Private native source excerpts and original line
references are retained outside the repository.

## Verification boundaries

The implementation round passed 3468 fast tests plus type/build, architecture
and refactor-evidence checks. Those checks do not prove the cause of a native
account-routing timeout. Publication-gate command results are recorded in the
release PR and downloadable verification metadata.

Build 28661 approvals, blocking/asynchronous answers, settings mutations,
cancellation and creation were not newly live-tested. Local receiver acceptance
is not proof of OpenClaw or WeChat delivery. Older-build evidence is retained in
the compatibility document. This release does not change local installations,
proxy settings, authentication or running services.

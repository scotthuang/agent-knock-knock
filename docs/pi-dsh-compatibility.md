# Pi and DeepSeek Harness connector compatibility

These are independently versioned controller connectors. Installing an AKK
core/OpenClaw release does not update an already installed connector. The
published 2026-10-14 connectors pin AKK core `0.14.7`; DSH connector `0.1.0-rc.6`
pins `0.14.8`. Each carries its runtime's canonical Skill and 26-tool
capability handshake. Neither connector update requires a new core release.

## DSH 0.2.1-rc.2 compatibility — 2026-10-17

`@scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.6` is an independent
**prerelease on npm `next`**, built against DSH `0.2.1-rc.2`, Cordis `4.0.5` and published
AKK core `0.14.8`. At verification time DSH npm `next` was `0.2.1-rc.2`, while
`latest` remained `0.2.0-rc.2`; neither is a stable release. The connector's
npm `latest` remains `0.1.0-rc.1`. Pi and core are unchanged by this release.

The [official DSH release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
adds DeepSeek-V4.1-Flash-1017 support. Comparing its actual packages with the
previous RC and alpha shows that AKK's command, Skill, message-source,
Agent Inbox and ordinary tool contracts remain compatible. PTC cancellation
and tool-mode changes do not affect the interfaces used by this connector.
The update aligns exact peers, SDK dependencies, the runtime version check,
lockfile and core dependency; it does not bypass Host compatibility preflight.

| Verification | Result and evidence boundary |
| --- | --- |
| Current RC SDK | Typecheck, 39 fast tests and package/Skill checks passed. |
| Previous `0.2.0-rc.2` SDK / Cordis `4.0.4` | Final Store patch: isolated typecheck, 39 fast tests and actual coherent launcher/helper resolution passed. |
| Retained `0.1.5-rc.2` / Cordis `4.0.2` and preview `0.2.1-alpha.2` / Cordis `4.0.5-alpha.1` | Each passed typecheck, 39 fast tests and actual coherent launcher/helper resolution with the final product sources. Old Web/model acceptance was not repeated; `0.1.1-rc.2` and `0.1.2-alpha.1` retain historical policy only. |
| Actual `0.2.1-rc.2` launcher and native registries | Official peer preflight, coherent runtime resolution and registration of all 26 tools passed. |
| Native Agent loop and callback helper | Busy injection and idle followup were consumed by a deterministic local provider. Duplicate notifications retained one message/acceptance ID; collisions, disposed/replaced Agents and closed routes were rejected. |
| Approval and typed-question tool contracts | Real upstream ToolRuntime preserved decisions, exact identifiers and Unicode answers. The downstream coding-agent results in these checks were fixtures, not new live approval/question acceptance tests. |

A real account-backed Web task also passed: the DSH model called Send, the
dedicated Codex task completed, its callback was accepted once by the DSH
Inbox, and the DSH model consumed it and replied. This used Codex CLI
`0.162.1` with the already running backend `0.163.0`; neither that backend nor
other business sessions were restarted. No external chat delivery was tested.

The live check exposed a separate shared-Store hazard: another Host can claim
a native callback without the owning DSH profile. An isolated actual-core
reproduction confirmed this failure mode. The connector now defaults tools
and lifecycle workers to one stable DSH-specific Store. Explicit Store paths
are preserved, and old records are neither migrated nor replayed. Parallel
DSH Hosts/profiles still need distinct explicit Store paths; cross-Host
ownership filtering in core is outside this change.

The independent connector publication gate runs typecheck, `test:fast`, and
package/Skill checks on clean synchronized `main`, then publishes to `next`.
The root OpenClaw release suite is not this connector's publication gate.
Callback admission, model consumption and external-chat delivery remain separate facts. Old process-owned callback
routes are not transferred to a restarted Web Host.

## Upstream versions checked on 2026-10-14

| Controller | Upstream version | Release channel | Connector |
| --- | --- | --- | --- |
| Pi (`@earendil-works/pi-coding-agent`) | `1.2.0` | Stable, npm `latest`; published 2026-10-12 UTC | `@scotthuang/agent-knock-knock-pi@0.1.0-poc.3`, npm `next` |
| DeepSeek Harness (`@deepseek-ai/dsh`) | `0.2.0-rc.2` | Release candidate, npm `latest` and `next`; published 2026-09-29 UTC | `@scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.5`, npm `next` |
| DeepSeek Harness | `0.2.1-alpha.2` | Alpha preview, npm `alpha`; published 2026-10-09 UTC | Separate preview validation; see the connector guide |

An npm `latest` tag does not make DSH a stable release. Neither connector is
promoted to a stable release by this update. Their existing `latest` tags stay
unchanged; select `next` or the exact connector version above.

Official upstream records:

- [Pi 1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)
- [DSH 0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
- [DSH 0.2.1-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2)

## Contract changes

The previous connector manifests pinned core `0.13.3`, while the current source
required a capability handshake introduced later. This update aligns the
installed dependency, lockfile, bundled Skill and registered tool catalog.
The previously published connector artifacts predated that handshake change;
the dependency mismatch was not evidence that those old published artifacts
already called the missing method.

Pi now uses the current tool execution context and supports its startup/busy
message semantics. Completion messages use `triggerTurn: true`; when the Host
is already starting or running, they use `deliverAs: "followUp"`. The
per-process Host Profile records the actual supported Pi version. Approval
confirmation covers exact conversation and Watch targets as well as the older
managed Turn/terminal targets, with explicit decision labels.

DSH 0.2 removed the catch-all `source.kind: "plugin"` type. AKK declares and
uses its own `agent-knock-knock` producer source. Its package peers and runtime
resolver cover reviewed coherent DSH package sets and their Cordis versions;
unknown or mixed DSH package versions still fail closed. Cordis compatibility
is declared through package peers. The native tool registry receives
the actual core schemas after the existing lossless projection and validation.

## Validation record

Validation used Node.js `24.18.0` on macOS, disposable Host profiles/stores and
an explicitly selected dedicated Codex CLI `0.162.1` connected to backend
`0.162.1`. Existing business sessions and the OpenClaw Gateway were not
restarted or used as test receivers.

| Check | Evidence scope |
| --- | --- |
| Root typecheck, architecture validator, fast tier and package dry-run | Passed; 2,982 fast tests. No core runtime logic changed. |
| Pi `1.2.0` | Connector typecheck, 29 fast tests and package checks; real CLI loading from an isolated packed install; real SDK extension/Agent loop with a deterministic local provider. |
| Pi `0.84.4` | Same packed connector loaded in a separate installation of the older real Host; `AKK ready` and `/akk` registration. This is not a repeated full old-version live task matrix. |
| DSH `0.2.0-rc.2` | Connector typecheck, 35 fast tests, package checks, official peer preflight and actual launcher resolver; real native Agent/ToolRuntime and connector mount. |
| DSH `0.2.1-alpha.2` | Separate coherent SDK typecheck/35 fast tests plus the actual alpha launcher resolver and official peer preflight without exemptions. No full alpha Web/model task acceptance claim. |
| DSH `0.1.5-rc.2` | Retained exact SDK dependency-tree typecheck and 35 fast tests with core `0.14.7`; not a new full Web acceptance run. |
| DSH `0.1.1-rc.2` / `0.1.2-alpha.1` | Historical accepted-version policy retained. Not revalidated as live Hosts in this release. |

Pi's real native loop verified idle, startup (`before_agent_start` held) and
active-generation callback consumption, duplicate admission without another
turn, and rejection of a superseded branch route. These checks use upstream
Host code and a deterministic provider, not a fake Extension API.
The real Pi SDK also sent tasks to the dedicated Codex target, read Status,
and consumed completion callbacks. Scripted decisions at Pi's confirmation
UI boundary allowed one command and rejected another; the allowed command
executed, while the rejected task settled as `interrupted` and its marker file
was absent. A native asynchronous question was answered through the exact
advertised interaction. This is not a manual Pi TUI/browser usability test.

DSH's real native tool registry called Send and Status against the dedicated
Codex target, then received and consumed the exact completion callback. A
harmless native command approval was allowed and its execution/result verified;
a native asynchronous question was answered through the advertised exact
interaction. A requested blocking question was unavailable in the target's
Default mode and is not counted as a passed blocking-question test. Idempotent
Send and completed-task recovery did not create another task or callback.
A separate real DSH Agent loop verified busy `inject` consumption, duplicate
admission without a second message, collision rejection, Agent disposal and
replacement with the same ID, and rejection after route closure.

The Host model providers in these loop tests were deterministic local test
providers; the controlled Codex tasks used the real installed CLI/backend and
model. This separates protocol/consumption evidence from claims about a
particular external Pi/DSH model provider or browser UI.

Reproducible repository checks:

```sh
npm run typecheck
npm run validate:architecture
npm run test:fast
npm pack --dry-run
npm --prefix connectors/pi run typecheck
npm --prefix connectors/pi run test:fast
npm --prefix connectors/pi run pack:check
npm --prefix connectors/deepseek-harness run typecheck
npm --prefix connectors/deepseek-harness run test:fast
npm --prefix connectors/deepseek-harness run pack:check
```

The canonical connector publication gate is each connector's
`npm run release:check -- --publish --confirm-version <exact-version>` on clean,
synchronized `main`. It rechecks typecheck, fast tests, packed Skill contents,
dependency/version parity and registry/tag absence immediately before publish.
The root OpenClaw/ClawHub release suite is not the release gate for these
independent packages; this update does not republish core or ClawHub.

## Acceptance and recovery boundaries

A connector callback acknowledgement means admission by the controller Host,
not successful model consumption or delivery to a person's chat channel.
This release does not add WeChat or other external-channel delivery.

Pi persists its callback inbox before acknowledging admission. Its supported
`sendMessage()` APIs return no transactional consumption receipt, so a crash
between dispatch and inbox bookkeeping retains a narrow at-least-once risk.
An old route does not silently migrate to a replacement Host process, session
or branch. DSH binds routes to the exact live Agent object; its accepted map
and route authority are process-local. A restarted Host does not inherit old
routes merely because it uses the same session identifier.

Only use approvals/questions advertised by the current coding target. Pi
requires its native interactive confirmation surface for approval/cancel;
headless contexts cannot bypass it. DSH does not add a native human approval
dialog: the controller must already have the user's explicit decision before
calling an approval tool. Neither connector grants blanket permission.

For installation, supported legacy versions and connector-specific limits,
see the [Pi guide](../connectors/pi/README.md) and
[DSH guide](../connectors/deepseek-harness/README.md).

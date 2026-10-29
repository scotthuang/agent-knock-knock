# Compact List v5 evaluation

Development evidence from 2026-10-29 for the List v5 presentation change in
0.16.8. This is separate from the discovery-speed improvements in 0.16.7.
See [the output contract](list-output.md) for format selection and safety rules.

## Decision

Integer enums are possible, but their dictionary and version handling cost more
than they save here. Keep readable state strings and booleans. Remove derived
per-row `usage` prose and `id` only when it exactly repeats `conversation_id`.
Keep identities, titles/projects, live-state uncertainty, capabilities, current
actions, dynamic arguments and exceptional/manual recovery information. Folded
Claude input blockers remain available as structured readiness facts.

The initial comparison on the previously captured two compact pages counted
the whole serialized output and, where relevant, dictionary delivery:

| Alternative | Saving | Tradeoff |
| --- | ---: | --- |
| Integer enums, first dictionary included | 0.72% | A new stable codebook and mismatch handling for very little gain |
| Shared repeated objects, dictionary included on each page | 5.04% | References obscure current facts and can require dictionary recovery |
| Short keys, first dictionary included | 13.92% | Renames existing consumer fields and adds decoding work |
| Existing short readable enums + remove repeated prose/IDs | 39.75% after actual repagination | No decoder or additional dictionary request; explicit new projection version |

The alternatives are payload experiments, not shipped formats. Dictionary
amortization depends on Host/Skill caching; it must not be assumed. The final
Skill adds 1,746 UTF-8 bytes over the baseline, loaded through the existing
Skill mechanism, not repeated in each result. Even charging that entire
increment to the first nine-conversation inventory leaves a 5,199-byte saving
across its complete results. If a Host reads the entire Skill on that first
inventory, Skill plus results total 121,775 bytes before and 116,576 after;
later inventories avoid repeating the Skill only if that Host retains it.
Model token costs and cache behavior were not
measured; bytes and the output's weighted-character policy are not token counts.

## Same-input measurements

Both versions receive the same frozen **raw** CLI discovery JSON. The real
snapshot has nine conversations: five Codex CLI and four Desktop entries with
their original connection states. Its private contents are not committed.
Synthetic inventories contain 240 distinct CLI/Desktop identities, Claude and
Codex agents, busy and unknown states, unconfirmed connections, approvals,
questions, management conflicts and deferred inspection. A second synthetic
case uses long Chinese titles, emoji and combining characters.

Every call uses `listLimit: 50`, the unchanged **24,576 UTF-8 byte / 12,000
weighted-character** whole-response budgets and all returned continuation
arguments. ASCII code points weigh 1; other code points weigh 16. Counts below
include complete JSON envelopes and every page. All selectors appeared exactly
once; no row used the oversized-row fallback in these measurements.

| Input | First-page rows v4 → v5 | Pages/calls v4 → v5 | Total UTF-8 bytes v4 → v5 | Total weighted chars v4 → v5 |
| --- | --- | --- | --- | --- |
| Real nine-conversation snapshot | 6 → 9 | 2 → 1 | 17,471 → 10,526 | 18,576 → 11,631 |
| 240 mixed conversations | 10 → 17 | 25 → 16 | 292,673 → 180,410 | 292,673 → 180,410 |
| 240 with long Unicode titles | 5 → 6 | 56 → 43 | 383,137 → 265,177 | 601,537 → 483,577 |

For the real snapshot, the old first page alone is 10,382 bytes / 10,941
weighted characters and contains six rows. The new single page is 10,526 bytes /
11,631 weighted characters and contains all nine. The 39.75% reduction compares
the **complete inventory**, not just the first page. The v4 compatibility path
adds a 26-byte explicit format parameter to the older continuation response;
the original captured production pages totalled 17,445 bytes.

Local projection plus serialization timing (Node v24.18.0, macOS arm64; two
warmups and nine alternating samples; medians for the complete inventory):

| Input | v4 | v5 |
| --- | ---: | ---: |
| Real nine-conversation snapshot | 1.562 ms | 1.007 ms |
| 240 mixed conversations | 101.439 ms | 71.852 ms |
| 240 with long Unicode titles | 193.574 ms | 155.797 ms |

These are measured local CPU times, **not** Gateway round-trip, discovery or
model-consumption latency. No production Host was replaced to measure v5.
Reducing output does not itself make one native discovery cheaper. Fewer pages
can avoid repeat discovery calls when a controller reads the full inventory;
that end-to-end effect remains unmeasured here.

## Compatibility and validation

Updated OpenClaw/Pi/DSH connectors select v5 explicitly. Generic Host SDK and
MCP integrations retain v4 by default. `listProjectionVersion: 4 | 5` overrides
the Host default; diagnostic List keeps v4 unless explicitly overridden.
Tool schema defaults participate in the catalog digest, and connector Skills
stay synchronized. Action contract 35 and private mutation authority are
unchanged. A new projection does not authorize an operation.

The strict selector rejects null, strings and unknown versions before starting
discovery. v4 cursors preserve their previous scope; v5 cursors bind format and
filters. Cross-format continuation is rejected. An unfamiliar response format
requires a fresh read-only v4 request or exact Status, not guessed write inputs.
No numeric codebook, executable decoder or untrusted code-loading path exists.

Regression coverage checks full pagination/selector preservation, version
mismatch, unconfirmed Desktop entries, retained dynamic answers and blockers,
distinct null/false/unknown/deferred values, explicit row facts, private field
filtering, oversize fallback, old MCP clients and first-party Host defaults.
OpenClaw registration, in-memory MCP transport and connector tests use isolated
relay fixtures; they do not send work to real coding-agent sessions.

Reproduce the anonymous benchmark after building:

```sh
npm run build
node scripts/measure-list-projection.js --synthetic-count 240 --iterations 9
```

Use `--input /path/to/private/raw-list.json --out /path/to/metrics.json` to add a
frozen raw snapshot. The script rejects compact Host input, verifies input
immutability and exact selectors, and emits only metrics/hashes, never the
snapshot's titles, paths or IDs. Runtime/Host wrappers may add their own metadata;
this benchmark counts the complete model-facing List JSON, not an entire RPC
transport envelope that may also duplicate it as structured details.

## Independent installed-candidate acceptance

On 2026-10-30, a user-reviewed local candidate was installed through the official
OpenClaw CLI and exercised from the real OpenClaw tool entry. A single
`agent_knock_knock_list({listLimit:50})` call, with no format override or filter,
returned all nine current conversations on one page: five CLI and four Desktop.
Three Desktop entries with no verified live owner stayed visible and unavailable
for Send. Default projection was v5 and action contract remained 35; the budgets
were unchanged. A second actual tool result measured 10,523 UTF-8 bytes and
11,628 weighted characters. Private titles, selectors and raw output are not
published. These measurements are not token counts or network-latency results,
and do not guarantee that arbitrarily large inventories fit on one page.

The installed candidate also passed independent fast tests under a restrictive
umask and a nondefault temporary directory. Its public-progress, routing and
Watch behavior was not retested by dispatching real work for this presentation
change. Formal release gates are recorded separately for the published version.

# Claude historical resume verification

[PR #540](https://github.com/scotthuang/agent-knock-knock/pull/540) originated
at `9c7a9a1`. This check used its integrated main candidate and isolated real
Claude Code 2.1.303, tmux 3.8 and macOS arm64. The test loaded Claude's official
Darwin ARM64 npm artifact and validated the published integrity. The original
DSH report is separate evidence for the earlier baseline.

The actual owned terminal reported:

```text
✻ Worked for 2s · done 4:09 PM · 2 shells still running
⏵⏵ auto mode on · 2 shells · ↓ to manage
```

The exact PID registry row reported `shell`. The agents command
enumeration reported `busy` during the experiment, which is why the test
compares the exact PID record that AKK uses for lifecycle observation.

| Observation | Result |
| --- | --- |
| Resume with a visible test draft | Refused. Zero provider text or key calls. Draft unchanged. |
| Resume from a fresh empty main prompt | One Ctrl+S probe, one resume command and one Enter. |
| Native registry before and after | Same process. Exact historical UUID selected. |
| Public AKK resume receipt | `committed` |
| Owned Bash processes | Two before and two after, with the same PIDs. Both exited naturally. |

The check used the real `list-resumable-threads` and `resume-thread`
dispatchers, a private tmux socket and private Claude config and AKK Store.
The provider wrapper recorded actual text/key calls. It did not replace the
terminal state, native registry or transition result. UUIDs, PIDs, command
fences and private paths are omitted.

Regression fixtures cover visible and hidden drafts, stale process identity,
wrong targets, unreturned or mismatched tools and interleaved results. The
hidden-stash fixture verifies a single restore key and no command input.
The successful live test exercised an empty stash. Other Claude versions,
Herdr, dual-Host lifecycle and rollback across versions were outside the
successful live check. See the PR for the final review and test commands.

# Set Codex permissions before a task

AKK can inspect and change the built-in permissions of an existing, idle Codex
session through its native `/permissions` menu. The terminal must have an empty
Composer and no running task, approval, question, editor, or viewer. AKK verifies
the physical pane/process and native thread before acting.

In a controller conversation:

```text
/akk list
/akk permissions <exact-terminal-id>
/akk set-permissions <exact-terminal-id> <advertised-mode-id>
```

Use the permission action advertised by the current List row. The first command
opens and dismisses closed native UI inspection; it does not change permissions.
It returns the current mode and the modes this native picker actually offers.
Show their descriptions to the user, then use the exact semantic ID they select.
For example, `ask_for_approval` may be available on a given Codex build. A mode
reported as current is not necessarily selectable: macOS can report `read_only`
while omitting it from its menu. Named/custom profiles are not supported.

The corresponding tools are:

```text
agent_knock_knock_permission_options({terminal_id})
agent_knock_knock_set_permissions({terminal_id, mode})
```

Both calls must use the same controller conversation. The private catalog is
valid for one attempt only; a refresh replaces it. Callers cannot provide raw
slash commands, keys, menu indexes, display labels, paths, fingerprints, or tokens.

Full Access requires the user's explicit choice or prior explicit authorization
for that mode. Its exact native confirmation belongs to this closed transaction;
it is not a generic approval action. A task request or an execution denial alone
does not authorize AKK to raise permissions. Ordinary Send never changes them.

A verified change returns `outcome=changed` or `already_effective`, the requested
and effective mode, `scope=current_session`, and `defaults_changed=false`.
Changes apply to this session/thread and may remain when the thread is resumed;
they do not change global defaults. Send the task only after the effective mode
matches the request. If the result is `uncertain`, inspect the terminal and do not
retry automatically. A running or blocked terminal must reach a safe idle state
before permission inspection; AKK does not interrupt its task to open the menu.

## Compatibility and verification

The permission-write profile currently covers Codex 0.159.2 and 0.159.3. It is
independent of native model selection, task observation, and interaction-write
profiles. Unsupported versions, named/custom profiles, disabled or incomplete
menus, and conflicting native status stop the operation before a permission
selection. A permission catalog never grants authority over another native
thread, even when its process and pane are unchanged.

On 2026-10-02, isolated macOS sessions running the locally installed Codex
0.159.3 were exercised through the built AKK CLI:

- **tmux:** discovered `read_only`, selected `ask_for_approval`, and proved
  `Workspace (Ask for approval)` in a fresh native status plus the menu's current
  marker. A subsequent AKK Send created a temporary file with exactly the
  requested contents, and Codex returned `DONE`.
- **Herdr:** discovered `read_only`, selected `full_access` through the exact
  native confirmation, then proved `Full Access` in a fresh status and the
  reopened menu's current marker. The operation dismissed the menu afterward.
- Both sessions used a temporary workspace and private AKK Store. Existing user
  sessions were untouched. Permission selection did not change global Codex
  configuration; the test-only workspace trust entry was removed on cleanup.

`npm run test:fast` passed all 2,433 tests, including stale physical/thread
identity, stale catalogs, confirmation grammar, changed input frames, uncertain
transport, one-attempt authority, and ordinary Send/approval separation.
`npm run validate:architecture` and `npm run validate:refactor-evidence` passed.
Full/release suites were not run, per the repository's development test policy.

Codex 0.159.2 has source-contract and regression coverage; it was not launched
for this live check. `approve_for_me` and a selectable `read_only` transition,
custom profiles, other platforms, and an external controller's complete
permission-to-callback conversation were not exercised live. Host/connector
tool registration and controller-scoped authority are covered by regression
checks; the live operations above used the CLI.

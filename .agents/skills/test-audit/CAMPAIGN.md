# Test-pruning campaign

Use this mode when the task calls for a complete subsystem or repository sweep. Apply the value bar, retention rules, candidate evidence, and fast-only validation in [SKILL.md](SKILL.md). A sample of files is a focused audit, not a completed campaign.

## 1. Pin scope and baseline

Record the starting commit, worktree status, scope boundary, test/support line counts, and the current root tier manifest. Enumerate every owned test file, connector test, UI test, script/QA scenario, fixture, and generated test declaration that affects the scope. Run the permitted fast tier for baseline evidence. Label integration/release-only cases **unrun under repository policy**; do not manufacture per-file pass/fail states from static review.

Done when the file/declaration inventory and baseline evidence are reproducible.

## 2. Partition by production owner

Assign every in-scope file and scenario to exactly one lane. Lanes follow the production contract owner rather than only filename prefixes. Include shared-boundary tests that exercise the subsystem. Record cross-lane cases explicitly so two lanes do not silently delete the same contract.

Done when no in-scope file or scenario is omitted or double-owned.

## 3. Make a read-only case ledger

Read every assigned test and its relevant production path, callers, history, sibling implementations, and tier routing. Give every test declaration one mark and a short evidence line: `R` retain with contract/regression; `F` repair a valuable but vacuous assertion; `C` consolidate into a named keeper; `D` delete with remaining proof or no-contract reasoning. If only part of a declaration is redundant, mark it `R` and annotate the affected assertion block with its separate action. Split table rows when rows warrant different marks. Count dynamically generated cases without treating a declaration count as an executed-case count.

Done when every in-scope declaration has a mark, and every `C`/`D` has the seven candidate fields from [SKILL.md](SKILL.md).

## 4. Plan the layer cutover

Review the ledger a second time by observable contract. Name the strongest keeper for each contract, the unique assertions to move, redundant files/layers to retire, and test-only production/support seams unlocked. Correct ledger mistakes before editing. Recheck manifest routes, exact public-contract witnesses, and architecture/evidence guards that mention the candidate.

Done when each planned deletion has a keeper or a justified absence of contract.

## 5. Cut over in owner-sized batches

Make edits per lane, with one owner for shared harness changes. Carry unique proof into keepers before deleting old tests. Update test-tier classification and witness references when needed. Run `npm run test:fast` after affected batches, touched connector fast tiers when relevant, and non-test validators for changed contracts. Do not run integration/full/affected suites during an audit.

Done when the keepers' permitted checks pass and the manifest and validators agree with the final layout.

## 6. Preservation review and handoff

Have an independent pass compare removed assertions with retained keepers when possible. Resolve any lost contract with a focused repair. For a restored fast-tier contract, a deliberate temporary mutation can show the keeper fails; restore production bytes afterwards. For integration-only proof, record the gap for the actual publication gate. Reconcile any upstream branch changes by inspecting new regressions and assigning them an owner before claiming the sweep complete.

Hand off the full ledger, scope coverage, retained false positives, before/after test/support versus production counts, validation actually run, and named follow-ups. Do not call an audit complete if its inventory or contract ownership is still uncertain.

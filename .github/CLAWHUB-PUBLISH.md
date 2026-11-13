# ClawHub trusted publication

`clawhub-publish.yml` is a manual publication workflow, not a pull request test
runner. It uses the existing ClawHub Trusted Publisher binding for this repository
and workflow filename. No stored ClawHub token or manual override is required.

The reviewed `.github/clawhub-release.json` identifies the already-tested GitHub
Release TGZ, original source commit, version, size and SHA-256. The workflow never
rebuilds it, publishes to npm, installs AKK locally, or changes the publisher binding.
For 0.16.14, the manual macOS publication gate passed **3,966/3,966** core tests,
both connector offline gates, isolated OpenClaw 2026.9.1, runtime Inspector,
type checking, architecture/evidence validation and package dry-run checks.
[Gate run 43476417909, attempt 2](https://github.com/scotthuang/agent-knock-knock/actions/runs/43476417909/attempts/2)
tested tree `28c55b2b88f63d6fa724025f522a89f40591d9b6`; the release product commit
`f31724452a6f18396d8c9b93b673438ca1d88a76` has the same tree (PR #519, following #518).
This publication update changes only the release manifest and this documentation.
The coordinated Pi `0.1.0-poc.22` and DSH `0.1.0-rc.27` npm packages pin core
`0.16.14`; this workflow uploads only the frozen core ClawHub archive.
Both new connector prereleases use `next`; DSH `latest=rc.24` remains unchanged.

The workflow also supports an explicit read-only `verify_release=true` gate on
`release/` branches with `publish=false`. It does not run automatically on PRs
and grants that verification job no publishing or OIDC permission.

ClawHub requires the trusted source SHA/ref to match the running workflow. The
workflow therefore checks that its commit descends from the artifact's original
commit and differs only in the allowlisted non-packaged publication files. It records
both commits separately. Product changes require a new validated release artifact;
they cannot be substituted into an old immutable version.

1. Review the release manifest against the public npm/GitHub Release archive.
2. Run `gh workflow run clawhub-publish.yml --ref main -f publish=false` to validate
   the public archive and package contents without requesting OIDC or uploading.
3. Run with `-f publish=true` to publish after the release gates have passed.

All actions are pinned to full commit SHAs. Runs are serialized. The helper uses
the npm `clawhub@0.23.3` schema and dependencies. Its HTTP transport comes from
the merged upstream [PR #3586](https://github.com/openclaw/clawhub/pull/3586),
fixed at commit `d118f17fd366e5cdc3ad9c8abcea51941b97636f` with a checked SHA-256.
Node 24 removes TypeScript types into the temporary tooling directory; this does
not modify the release archive or replace the installed AKK. The npm 0.23.3
transport itself does not support the upstream per-request timeout option.

Only the package upload uses the upstream 300-second request timeout. Ordinary
API reads retain their 15-second default. This timeout covers waiting for response
headers; it is not a total response-body deadline. The overall job still has a
40-minute limit. The receipt records the transport commit/digest and upload budget.
The helper disables package POST
retries: an upload timeout is not proof that nothing was accepted. It first reads
the exact version's publication state; published versions are verified, pending
versions are observed, and failed versions require inspection. Only an absent
version permits one upload. A rerun cannot upload again; inspect the saved receipt
and current remote state before deliberately starting a new run.

By default, an exact pending acknowledgement with an attempt ID finishes the
submission step successfully as `accepted_pending`. This means ClawHub accepted
the artifact for processing, not that scanning, `latest` or public downloading
has completed. Existing pending attempts are also reported without uploading again.

Set the manual workflow input `wait_for_publication=true` for the optional
30-minute read-only wait and public TGZ/latest/clean/herdr verification. Published
versions are verified directly. Unknown POST outcomes still receive bounded
read-only reconciliation; only a confirmed pending attempt permits accepted
submission, and neither unknown nor failed outcomes count as accepted. An
explicit HTTP 4xx followed by absent publication fails with a redacted diagnostic.
Receipts preserve these distinct outcomes. Never rerun an uncertain upload as
permission to POST again; first inspect its exact remote state.

Local validation: `node scripts/publish-clawhub-release.mjs` (needs the repository's
pinned ClawHub development dependency, downloads the existing release archive,
does not authenticate or publish). A workflow-only change that leaves this archive
unchanged does not rebuild or republish the npm package.

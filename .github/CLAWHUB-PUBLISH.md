# ClawHub trusted publication

`clawhub-publish.yml` is a manual publication workflow, not a pull request test
runner. It uses the existing ClawHub Trusted Publisher binding for this repository
and workflow filename. No stored ClawHub token or manual override is required.

The reviewed `.github/clawhub-release.json` identifies the already-tested GitHub
Release TGZ, original source commit, version, size and SHA-256. The workflow never
rebuilds it, publishes to npm, installs AKK locally, or changes the publisher binding.
For 0.16.10, the release gate passed 3,913 core tests, both connector verification
gates, isolated OpenClaw 2026.9.1, runtime Inspector and package dry-run checks.
The product commit is `4dbcdbe47f18a819dc848f59e4baf7ca26d880f7` (PR #494).
This publication update changes only the release manifest and this workflow
documentation. Pi `0.1.0-poc.18` and DeepSeek Harness `0.1.0-rc.22` are separate
npm publications pinned to core `0.16.10`; this workflow publishes only the core
ClawHub package.

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

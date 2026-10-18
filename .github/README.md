# ClawHub trusted publication

`clawhub-publish.yml` is a manual publication workflow, not a pull request test
runner. It uses the existing ClawHub Trusted Publisher binding for this repository
and workflow filename. No stored ClawHub token or manual override is required.

The reviewed `.github/clawhub-release.json` identifies the already-tested GitHub
Release TGZ, original source commit, version, size and SHA-256. The workflow never
rebuilds it, publishes to npm, installs AKK locally, or changes the publisher binding.
For 0.14.13, the existing release gate passed 3,548 tests plus isolated OpenClaw,
runtime Inspector and package dry-run checks before this archive was released.

ClawHub requires the trusted source SHA/ref to match the running workflow. The
workflow therefore checks that its commit descends from the artifact's original
commit and differs only in these four non-packaged publication files. It records
both commits separately. Product changes require a new validated release artifact;
they cannot be substituted into an old immutable version.

1. Review the release manifest against the public npm/GitHub Release archive.
2. Run `gh workflow run clawhub-publish.yml --ref main -f publish=false` to validate
   the public archive and package contents without requesting OIDC or uploading.
3. Run with `-f publish=true` to publish after the release gates have passed.

All actions are pinned to full commit SHAs. Runs are serialized. The helper uses
the pinned official ClawHub schema and transport, but disables package POST
retries: an upload timeout is not proof that nothing was accepted. It first reads
the exact version's publication state; published versions are verified, pending
versions are observed, and failed versions require inspection. Only an absent
version permits one upload. A rerun cannot upload again; inspect the saved receipt
and current remote state before deliberately starting a new run.

After upload, it polls read-only for at most 30 minutes and then checks public
version/latest, clean scan, the `herdr` topic and the downloaded TGZ's SHA-256.
Pending, unknown or failed outcomes are not reported as successful publication.
An explicit HTTP 4xx followed by an absent publication stops with a bounded,
credential-redacted server diagnostic, rather than waiting for a nonexistent
scan. Transport-unknown outcomes still receive read-only reconciliation.
The uploaded receipt contains no tokens. Do not use a workflow rerun to bypass a
failed or uncertain publication; inspect its exact remote state first.

Local validation: `node scripts/publish-clawhub-release.mjs` (needs the repository's
pinned ClawHub development dependency, downloads the existing release archive,
does not authenticate or publish). A workflow-only change that leaves this archive
unchanged does not rebuild or republish the npm package.

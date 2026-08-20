# Agent Instructions

## Test execution policy

- During normal development, debugging, refactoring, review, and local installation or local verification, run only the fast test tier: `npm run test:fast`.
- Do not run `npm test`, `npm run test:full`, `npm run test:integration`, `npm run test:release`, `npm run test:release:live`, or an equivalent command that executes integration/full tests during those workflows.
- Type checking, builds, architecture/evidence validators, and non-test installation or health checks may still be run when relevant. They do not authorize a broader test tier.
- Run the full/release test suite only as the immediate pre-publication gate for an actual npm or ClawHub package release.
- A local install is not a package release and must not trigger the full test suite.
- If full-suite evidence would otherwise be useful outside a release, report that it was skipped under this policy instead of running it.

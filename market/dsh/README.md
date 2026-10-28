# AKK index for the DSH plugin market

Add this HTTPS index in DeepSeek Harness to discover the AKK connector:

```text
https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/market/dsh/index.json
```

This is an **AKK-maintained third-party index**, not a default DeepSeek index or an official recommendation. DSH does not ship with index sources. The index lists a selected, published connector release and installs that **exact version**, including its prerelease suffix. It does not resolve npm's `latest` tag.

## Add the index

In DSH Web, open **Plugins → Experimental plugins → More**, enable the **Custom plugin market**, and open **Discover**. Add the URL above, search for **Agent Knock Knock**, and inspect the version and compatibility before confirming installation. If DSH requests a restart to load the installed bundle, finish active work and restart that DSH Web Host.

The reader and install-target behavior were verified with DSH **0.2.1-rc.2**. The index carries the connector's published DSH peer requirements; it does not declare newer RC/alpha Hosts compatible. Installation still checks the package's actual peer requirements, including Cordis. Never bypass an incompatibility warning to install AKK.

For the supported POSIX Web Host setup, `pnpm`, connector capabilities, permissions, and limitations, see the [DSH connector guide](../../connectors/deepseek-harness/README.md). The equivalent manual command is:

```sh
dsh plugin --profile web add @scotthuang/agent-knock-knock-deepseek-harness@next
```

`next` deliberately selects the current prerelease connector. A bare package name can select the older npm `latest` release. For a reproducible install, replace `next` with the exact version shown by this index. The market is an installation path, not an automatic update service.

## Regenerate after a connector release

The index is generated from **already-published npm metadata**. It contains no credentials, local configuration, user sessions, or fabricated publish date. Do not generate entries for unpublished candidates.

Install the pinned official validator in a temporary directory; this does not modify a DSH profile:

```sh
validator_dir="$(mktemp -d)"
npm install --prefix "$validator_dir" --ignore-scripts --no-audit --no-fund \
  @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2

node scripts/build-dsh-market.mjs \
  --version <published-connector-version> \
  --core-version <exact-pinned-core-version> \
  --validator-module "$validator_dir/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js"
```

Run the same command with `--check` to compare the committed file with the registry-derived output. Remove only the temporary validator directory when finished.

The generator has an exact package allowlist, verifies the connector and pinned core exist on the official npm registry, and requires the official `parseMarketIndex` validator. Its output is deterministic for the same registry metadata. The index has one selected connector version so prerelease selection cannot accidentally choose an old stable-tagged package.

DSH compatibility is derived from the published `@deepseek-ai/dsh*` peer ranges. All currently declared ranges are identical; this is the same result as the official generator's intersection. If they diverge, or an explicit `engines.dsh` differs, this script stops for review. It does not invent a broader compatibility range or change the connector's manifest. Older releases without an author use the documented, curated repository-owner label `scotthuang`.

After publishing the updated index, verify the public URL returns HTTP 200 without redirects, validate the downloaded JSON with the official parser, and use a temporary DSH profile to check the exact install spec. A valid index or successful package installation alone does not prove model execution, callbacks, or channel delivery.

## Format references

- [Official market guide](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market)
- [Official generator instructions](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/plugin-market-generator/README.zh.md)
- [Format-1 types and validator](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/util/plugin-market-index/src)
- [Official peer-range derivation](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/plugin-market-generator/src/packages.ts#L93)

The source links pin the reviewed upstream commit. Compatibility also has a separate check against the published, installed DSH 0.2.1-rc.2 reader; a newer source tree is not treated as proof of older Host behavior.

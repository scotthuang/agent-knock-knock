#!/usr/bin/env node
// Curated format-1 index for the one AKK DSH connector. No installs or dist-tag changes.
// Contract: deepseek-ai/deepseek-harness@f3803c96974ad4a94195fb97e5c637e9c2a3afe3
// packages/util/plugin-market-index and apps/plugin-market-generator/src/packages.ts.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PACKAGE = "@scotthuang/agent-knock-knock-deepseek-harness";
const CORE = "@scotthuang/agent-knock-knock";
const REGISTRY = "https://registry.npmjs.org";
const INDEX_URL = "https://raw.githubusercontent.com/scotthuang/agent-knock-knock/main/market/dsh/index.json";
const OUTPUT = fileURLToPath(new URL("../market/dsh/index.json", import.meta.url));
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DSH_PEER = /^@deepseek-ai\/dsh(?:-|$)/u;

function options(args) {
  const result = { check: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--check") result.check = true;
    else if (["--version", "--core-version", "--validator-module"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (result[flag] !== undefined) throw new Error(`Repeated option ${flag}`);
      result[flag] = value;
    } else throw new Error(`Unknown option ${flag}`);
  }
  for (const flag of ["--version", "--core-version"]) {
    if (!EXACT_VERSION.test(result[flag] ?? "")) throw new Error(`${flag} requires an exact version, not a tag or range`);
  }
  if (!result["--validator-module"]) throw new Error("--validator-module must name the official dsh-plugin-market-index module file");
  return result;
}

async function registryJson(path) {
  const response = await fetch(`${REGISTRY}/${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${path}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Registry response exceeded 8 MiB");
  return JSON.parse(body);
}

function dshRange(manifest) {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => DSH_PEER.test(name));
  if (peers.length === 0) throw new Error("Published connector has no DSH peer compatibility declaration");
  const ranges = [...new Set(peers.map(([, range]) => typeof range === "string" ? range.trim() : ""))];
  if (ranges.length !== 1 || !ranges[0] || ranges[0] === "*") {
    throw new Error("DSH peer ranges differ or are unrestricted; review their intersection before updating this generator");
  }
  // The upstream generator intersects DSH peers. Equal ranges have the same intersection.
  // Refuse a future explicit override rather than silently choosing the wrong contract.
  if (manifest.engines?.dsh !== undefined && manifest.engines.dsh !== ranges[0]) {
    throw new Error("Explicit engines.dsh differs from the DSH peers; review the compatibility contract");
  }
  return ranges[0];
}

async function main() {
  const args = options(process.argv.slice(2));
  const version = args["--version"];
  const coreVersion = args["--core-version"];
  const packument = await registryJson(encodeURIComponent(PACKAGE));
  const manifest = packument.versions?.[version];
  if (packument.name !== PACKAGE || manifest?.name !== PACKAGE || manifest.version !== version) {
    throw new Error(`No exact published ${PACKAGE}@${version}`);
  }
  if (manifest.deprecated) throw new Error("Refusing a deprecated connector release");
  if (manifest.dependencies?.[CORE] !== coreVersion) throw new Error("Published connector does not pin the requested exact core version");
  if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") throw new Error("Published package is not the expected DSH bundle");
  const core = await registryJson(`${encodeURIComponent(CORE)}/${encodeURIComponent(coreVersion)}`);
  if (core.name !== CORE || core.version !== coreVersion || core.deprecated) throw new Error("Expected core release is not available");
  const publishedAt = Date.parse(packument.time?.[version] ?? "");
  if (!Number.isFinite(publishedAt)) throw new Error("Missing actual registry publication timestamp");
  if (typeof manifest.description !== "string" || !manifest.description.trim()) throw new Error("Missing published description");
  const author = typeof manifest.author === "string" ? manifest.author.replace(/\s*<[^>]*>.*$/u, "").trim() : manifest.author?.name;
  const keywords = Array.isArray(manifest.keywords) ? [...new Set(manifest.keywords.filter((value) => typeof value === "string" && value.trim()))].sort() : [];
  const index = {
    format: 1,
    title: { en: "Agent Knock Knock for DeepSeek Harness", zh: "Agent Knock Knock · DeepSeek Harness 插件" },
    description: {
      en: "Maintainer-curated AKK connector releases. Third-party index; not an official DeepSeek marketplace or endorsement. Prerelease versions remain prereleases.",
      zh: "AKK 维护者提供的连接器索引；并非 DeepSeek 官方市场或官方推荐。预发布版本仍为预发布版本。",
    },
    plugins: [{
      name: PACKAGE,
      title: "Agent Knock Knock (AKK)",
      description: manifest.description,
      // Older published manifests omitted author; this is a curated repository-owner label.
      author: author || "scotthuang",
      homepage: "https://github.com/scotthuang/agent-knock-knock/tree/main/connectors/deepseek-harness#readme",
      repository: { url: "https://github.com/scotthuang/agent-knock-knock.git", directory: "connectors/deepseek-harness" },
      metadata: { keywords },
      versions: [{
        version,
        publishTimestamp: Math.floor(publishedAt / 1000),
        source: { type: "npm", registry: REGISTRY },
        engines: { dsh: dshRange(manifest) },
      }],
    }],
  };
  const { parseMarketIndex } = await import(pathToFileURL(resolve(args["--validator-module"])).href);
  if (typeof parseMarketIndex !== "function") throw new Error("Validator module does not export parseMarketIndex");
  parseMarketIndex(index, INDEX_URL);
  const json = `${JSON.stringify(index, null, 2)}\n`;
  if (args.check) {
    if (await readFile(OUTPUT, "utf8") !== json) throw new Error("Committed market index differs from the published registry metadata");
  } else await writeFile(OUTPUT, json);
  console.log(`${args.check ? "Verified" : "Generated"} ${PACKAGE}@${version}, core ${coreVersion}; official format-1 validation passed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

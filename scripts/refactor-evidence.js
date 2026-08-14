import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  selectAffectedTests
} from "./affected-test-selection.js";
import {
  loadAndValidateProductionModuleOwnership
} from "./production-module-ownership.js";
import {
  loadDynamicSubprocessEvidenceConfig
} from "./subprocess-dynamic-evidence.js";

export const TEST_EVIDENCE_MANIFEST_PATH =
  "config/refactor-test-evidence.json";
export const PUBLIC_CONTRACT_MANIFEST_PATH =
  "config/public-contract-witnesses.json";

const TEST_EVIDENCE_SCHEMA = "agent-knock-knock/refactor-test-evidence";
const PUBLIC_CONTRACT_SCHEMA =
  "agent-knock-knock/public-contract-witnesses";
const STARTUP_CALL_EXPRESSIONS = Object.freeze([
  "execFile",
  "execFileSync",
  "fork",
  "spawn",
  "spawnSync"
]);
const STARTUP_CATEGORIES = Object.freeze([
  "cli_process",
  "fake_node_process",
  "other_process_or_adapter"
]);
const INCLUDED_STARTUP_CATEGORIES = Object.freeze([
  "cli_process",
  "fake_node_process"
]);
const LOOKAHEAD_CHARACTERS = 500;

const PUBLIC_COMMANDS = Object.freeze([
  "delegate",
  "list",
  "status",
  "send",
  "new-thread",
  "clear-thread",
  "list-resumable-threads",
  "threads",
  "native-inspect",
  "native-status",
  "resume-thread",
  "reconcile-binding",
  "respond",
  "approve",
  "cancel",
  "renew",
  "reconcile-monitors",
  "close",
  "transcript",
  "install-openclaw",
  "doctor",
  "callback",
  "retry-callback",
  "monitor"
]);
const PUBLIC_ACTIONS = Object.freeze([
  "send",
  "new_thread",
  "list_resumable_threads",
  "native_inspect",
  "resume_thread",
  "reconcile_binding",
  "respond",
  "status",
  "approve",
  "cancel",
  "renew",
  "retry_callback",
  "close"
]);
const OPENCLAW_TOOLS = Object.freeze([
  "agent_knock_knock_list",
  "agent_knock_knock_list_resumable_threads",
  "agent_knock_knock_native_inspect",
  "agent_knock_knock_new_thread",
  "agent_knock_knock_reconcile_binding",
  "agent_knock_knock_resume_thread",
  "agent_knock_knock_status",
  "agent_knock_knock_send",
  "agent_knock_knock_respond",
  "agent_knock_knock_renew",
  "agent_knock_knock_retry_callback",
  "agent_knock_knock_cancel",
  "agent_knock_knock_close",
  "agent_knock_knock_approve"
]);
const MIGRATION_IDS = Object.freeze([
  "callback-outbox",
  "cli-runtime",
  "lifecycle-transition",
  "monitor-seams",
  "mutation-lock-shell",
  "terminal-binding-authority",
  "terminal-dispatch-ledger",
  "terminal-dispatch-policy",
  "terminal-list-renderer",
  "verified-dead-agent"
]);

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const object = assertObject(value, label);
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(object).sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail([
      missing.length > 0 ? `${label} missing keys: ${missing.join(", ")}` : "",
      unknown.length > 0 ? `${label} has unexpected keys: ${unknown.join(", ")}` : ""
    ].filter(Boolean).join("; "));
  }
  return object;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function assertInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean`);
  }
  return value;
}

export function enforceRequiredFinalThreshold({ required, targetMet, label }) {
  if (required && !targetMet) {
    fail(`${label} final threshold is required but not met`);
  }
}

function assertExactArray(actual, expected, label) {
  if (!Array.isArray(actual) ||
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])) {
    fail(`${label} must equal ${JSON.stringify(expected)}`);
  }
  return actual;
}

function assertUniqueStrings(value, label, { sorted = false } = {}) {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || entry.length === 0
  )) {
    fail(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} contains duplicate entries`);
  }
  if (sorted && value.some((entry, index) =>
    index > 0 && value[index - 1] > entry
  )) {
    fail(`${label} must be sorted`);
  }
  return value;
}

function assertRepositoryPath(value, label) {
  const repositoryPath = assertString(value, label);
  if (repositoryPath.includes("\\") ||
      repositoryPath.startsWith("/") ||
      repositoryPath.startsWith("./") ||
      repositoryPath.split("/").includes("..")) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return repositoryPath;
}

function assertPathArray(value, label) {
  const paths = assertUniqueStrings(value, label, { sorted: true });
  for (const [index, repositoryPath] of paths.entries()) {
    assertRepositoryPath(repositoryPath, `${label}[${index}]`);
  }
  return paths;
}

function readJson(repoRoot, repositoryPath) {
  const absolutePath = path.join(repoRoot, repositoryPath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(
      `cannot read ${repositoryPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readRepositoryFile(repoRoot, repositoryPath) {
  const absolutePath = path.join(repoRoot, repositoryPath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`required evidence path is missing: ${repositoryPath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function checkedGit(repoRoot, args, operation) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    fail(`${operation} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function resolveCommit(repoRoot, revision) {
  const resolved = checkedGit(
    repoRoot,
    ["rev-parse", "--verify", `${revision}^{commit}`],
    `git revision resolution for ${revision}`
  ).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    fail(`git returned an invalid commit id for ${revision}`);
  }
  return resolved;
}

function decodeNulPaths(output) {
  return output.split("\0").filter(Boolean);
}

function readRevisionBlobs(repoRoot, revision, repositoryPaths) {
  if (repositoryPaths.some((repositoryPath) => /[\r\n]/u.test(repositoryPath))) {
    fail("revision evidence paths must not contain line breaks");
  }
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${repositoryPaths.map((repositoryPath) =>
      `${revision}:${repositoryPath}`).join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    fail(`batch reading test sources at ${revision} failed${
      detail ? `: ${detail}` : ""
    }`);
  }
  const output = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
  let offset = 0;
  const sources = repositoryPaths.map((repositoryPath) => {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      fail(`git cat-file omitted the header for ${repositoryPath}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (!match) {
      fail(`git cat-file returned an invalid header for ${repositoryPath}`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail(`git cat-file returned an invalid size for ${repositoryPath}`);
    }
    const sourceStart = headerEnd + 1;
    const sourceEnd = sourceStart + size;
    if (sourceEnd >= output.length || output[sourceEnd] !== 0x0a) {
      fail(`git cat-file returned a truncated blob for ${repositoryPath}`);
    }
    offset = sourceEnd + 1;
    return {
      path: repositoryPath,
      source: output.subarray(sourceStart, sourceEnd).toString("utf8")
    };
  });
  if (offset !== output.length) {
    fail(`git cat-file returned unexpected trailing evidence at ${revision}`);
  }
  return sources;
}

function walkTypeScriptTests(repoRoot, directory = "test") {
  const absoluteDirectory = path.join(repoRoot, directory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const repositoryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return walkTypeScriptTests(repoRoot, repositoryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [repositoryPath]
        : [];
    })
    .sort();
}

function revisionTestSources(repoRoot, revision) {
  const resolved = resolveCommit(repoRoot, revision);
  const paths = decodeNulPaths(checkedGit(
    repoRoot,
    ["ls-tree", "-r", "--name-only", "-z", resolved, "--", "test"],
    `test source discovery at ${resolved}`
  )).filter((repositoryPath) => repositoryPath.endsWith(".ts"));
  return {
    revision: resolved,
    sources: readRevisionBlobs(repoRoot, resolved, paths)
  };
}

function worktreeTestSources(repoRoot) {
  return walkTypeScriptTests(repoRoot).map((repositoryPath) => ({
    path: repositoryPath,
    source: readRepositoryFile(repoRoot, repositoryPath)
  }));
}

export function countStaticSubprocessStartupSites(sources) {
  const counts = Object.fromEntries(STARTUP_CATEGORIES.map((category) =>
    [category, 0]
  ));
  const startupCall = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/gu;
  for (const source of sources) {
    if (!source.source.includes("node:child_process")) {
      continue;
    }
    for (const match of source.source.matchAll(startupCall)) {
      const lookahead = source.source.slice(
        match.index,
        match.index + LOOKAHEAD_CHARACTERS
      );
      if (!lookahead.includes("process.execPath")) {
        counts.other_process_or_adapter += 1;
        continue;
      }
      if (/(?:binPath|cliPath|CLI_PATH|src\/cli\.js|dist\/src\/cli\.js|options\.cliPath)/u
        .test(lookahead)) {
        counts.cli_process += 1;
      } else {
        counts.fake_node_process += 1;
      }
    }
  }
  return counts;
}

function validateCounts(value, label) {
  const counts = assertExactKeys(value, STARTUP_CATEGORIES, label);
  for (const category of STARTUP_CATEGORIES) {
    assertInteger(counts[category], `${label}.${category}`);
  }
  return counts;
}

function includedStartupTotal(counts) {
  return INCLUDED_STARTUP_CATEGORIES.reduce(
    (total, category) => total + counts[category],
    0
  );
}

function assertCounts(actual, expected, label) {
  for (const category of STARTUP_CATEGORIES) {
    if (actual[category] !== expected[category]) {
      fail(
        `${label}.${category} expected ${expected[category]} ` +
        `but measured ${actual[category]}`
      );
    }
  }
}

function validateSubprocessEvidence(value, repoRoot) {
  const evidence = assertExactKeys(value, [
    "baseline",
    "current",
    "final_threshold",
    "measurement"
  ], "test evidence subprocess_startup_sites");
  const measurement = assertExactKeys(evidence.measurement, [
    "call_expressions",
    "included_categories",
    "kind",
    "lookahead_characters",
    "source_scope"
  ], "subprocess measurement");
  if (measurement.kind !== "static_source_call_sites") {
    fail("subprocess measurement kind must be static_source_call_sites");
  }
  if (measurement.source_scope !==
      "test/**/*.ts containing a node:child_process import") {
    fail("subprocess measurement source_scope changed");
  }
  assertExactArray(
    measurement.call_expressions,
    STARTUP_CALL_EXPRESSIONS,
    "subprocess measurement call_expressions"
  );
  assertExactArray(
    measurement.included_categories,
    INCLUDED_STARTUP_CATEGORIES,
    "subprocess measurement included_categories"
  );
  if (measurement.lookahead_characters !== LOOKAHEAD_CHARACTERS) {
    fail(`subprocess measurement lookahead_characters must be ${LOOKAHEAD_CHARACTERS}`);
  }

  const baseline = assertExactKeys(evidence.baseline, [
    "counts",
    "included_total",
    "revision"
  ], "subprocess baseline");
  const revision = assertString(baseline.revision, "subprocess baseline revision");
  const baselineCounts = validateCounts(baseline.counts, "subprocess baseline counts");
  if (baseline.included_total !== includedStartupTotal(baselineCounts)) {
    fail("subprocess baseline included_total does not match its category counts");
  }

  const current = assertExactKeys(evidence.current, [
    "counts",
    "included_total"
  ], "subprocess current");
  const currentCounts = validateCounts(current.counts, "subprocess current counts");
  if (current.included_total !== includedStartupTotal(currentCounts)) {
    fail("subprocess current included_total does not match its category counts");
  }

  const target = assertExactKeys(evidence.final_threshold, [
    "maximum_percent_of_baseline",
    "required"
  ], "subprocess final_threshold");
  const targetPercent = assertInteger(
    target.maximum_percent_of_baseline,
    "subprocess final_threshold maximum_percent_of_baseline"
  );
  if (targetPercent > 100) {
    fail("subprocess final_threshold maximum_percent_of_baseline must be <= 100");
  }
  const targetRequired = assertBoolean(
    target.required,
    "subprocess final_threshold required"
  );

  const historical = revisionTestSources(repoRoot, revision);
  if (historical.revision !== revision) {
    fail(
      `subprocess baseline revision must be the full immutable commit id ` +
      `(resolved ${historical.revision})`
    );
  }
  const measuredBaseline = countStaticSubprocessStartupSites(historical.sources);
  const measuredCurrent = countStaticSubprocessStartupSites(
    worktreeTestSources(repoRoot)
  );
  assertCounts(measuredBaseline, baselineCounts, "subprocess baseline counts");
  assertCounts(measuredCurrent, currentCounts, "subprocess current counts");

  const baselineIncluded = includedStartupTotal(measuredBaseline);
  const currentIncluded = includedStartupTotal(measuredCurrent);
  const currentPercentBasisPoints = baselineIncluded === 0
    ? (currentIncluded === 0 ? 0 : 10_001)
    : Math.round((currentIncluded * 10_000) / baselineIncluded);
  const targetMet = currentPercentBasisPoints <= targetPercent * 100;
  enforceRequiredFinalThreshold({
    required: targetRequired,
    targetMet,
    label: "subprocess startup sites"
  });
  return {
    baselineRevision: historical.revision,
    baselineCounts: measuredBaseline,
    baselineIncluded,
    currentCounts: measuredCurrent,
    currentIncluded,
    reductionBasisPoints: baselineIncluded === 0
      ? 0
      : Math.round(((baselineIncluded - currentIncluded) * 10_000) / baselineIncluded),
    targetMaximumPercent: targetPercent,
    targetRequired,
    targetMet
  };
}

function validateReplayScenario(value, index) {
  const label = `affected selector scenario ${index}`;
  const scenario = assertExactKeys(value, [
    "commit",
    "expected",
    "paths",
    "subject"
  ], label);
  const commit = assertString(scenario.commit, `${label} commit`);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    fail(`${label} commit must be a full immutable commit id`);
  }
  assertString(scenario.subject, `${label} subject`);
  assertPathArray(scenario.paths, `${label} paths`);
  const expected = assertObject(scenario.expected, `${label} expected`);
  if (expected.mode === "full") {
    assertExactKeys(expected, ["mode"], `${label} expected`);
  } else if (expected.mode === "targeted") {
    assertExactKeys(expected, ["integration_files", "mode"], `${label} expected`);
    assertPathArray(expected.integration_files, `${label} expected integration_files`);
  } else {
    fail(`${label} expected mode must be full or targeted`);
  }
  return scenario;
}

function validateAffectedReplay(value, { repoRoot, tiers }) {
  const replay = assertExactKeys(value, [
    "expected",
    "final_threshold",
    "scenarios"
  ], "affected selector replay");
  const threshold = assertExactKeys(replay.final_threshold, [
    "maximum_full_fallback_count",
    "required"
  ], "affected selector final_threshold");
  const targetMax = assertInteger(
    threshold.maximum_full_fallback_count,
    "affected selector final_threshold maximum_full_fallback_count"
  );
  const targetRequired = assertBoolean(
    threshold.required,
    "affected selector final_threshold required"
  );
  const expectedSummary = assertExactKeys(replay.expected, [
    "full_count",
    "full_rate_basis_points",
    "scenario_count",
    "targeted_count"
  ], "affected selector expected summary");
  for (const key of Object.keys(expectedSummary)) {
    assertInteger(expectedSummary[key], `affected selector expected ${key}`);
  }
  if (!Array.isArray(replay.scenarios) || replay.scenarios.length !== 10) {
    fail("affected selector replay must contain exactly 10 scenarios");
  }
  const scenarios = replay.scenarios.map(validateReplayScenario);
  const commits = scenarios.map((scenario) => scenario.commit);
  if (new Set(commits).size !== commits.length) {
    fail("affected selector replay contains duplicate commits");
  }
  const ownership = loadAndValidateProductionModuleOwnership({ repoRoot, tiers });
  let fullCount = 0;
  let targetedCount = 0;
  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    const resolved = resolveCommit(repoRoot, scenario.commit);
    if (resolved !== scenario.commit) {
      fail(`affected selector scenario ${index} commit is not immutable`);
    }
    const subject = checkedGit(
      repoRoot,
      ["show", "-s", "--format=%s", scenario.commit],
      `reading subject for ${scenario.commit}`
    ).trim();
    if (subject !== scenario.subject) {
      fail(
        `affected selector scenario ${index} subject expected ` +
        `${JSON.stringify(scenario.subject)} but found ${JSON.stringify(subject)}`
      );
    }
    const changedPaths = decodeNulPaths(checkedGit(
      repoRoot,
      [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "--no-renames",
        "-r",
        "-z",
        scenario.commit,
        "--"
      ],
      `reading changed paths for ${scenario.commit}`
    )).sort();
    assertExactArray(
      changedPaths,
      scenario.paths,
      `affected selector scenario ${index} historical paths`
    );
    const selection = selectAffectedTests(changedPaths, tiers, {
      productionOwnership: ownership
    });
    if (selection.mode !== scenario.expected.mode) {
      fail(
        `affected selector scenario ${index} expected mode ` +
        `${scenario.expected.mode} but selected ${selection.mode}`
      );
    }
    if (selection.mode === "full") {
      fullCount += 1;
    } else {
      targetedCount += 1;
      assertExactArray(
        selection.integrationFiles,
        scenario.expected.integration_files,
        `affected selector scenario ${index} integration files`
      );
    }
    results.push({ commit: scenario.commit, mode: selection.mode });
  }
  const scenarioCount = scenarios.length;
  const fullRateBasisPoints = Math.round((fullCount * 10_000) / scenarioCount);
  const actualSummary = {
    scenario_count: scenarioCount,
    full_count: fullCount,
    targeted_count: targetedCount,
    full_rate_basis_points: fullRateBasisPoints
  };
  for (const [key, actual] of Object.entries(actualSummary)) {
    if (expectedSummary[key] !== actual) {
      fail(
        `affected selector expected ${key} ${expectedSummary[key]} ` +
        `but replay measured ${actual}`
      );
    }
  }
  const targetMet = fullCount <= targetMax;
  enforceRequiredFinalThreshold({
    required: targetRequired,
    targetMet,
    label: "affected selector replay"
  });
  return {
    ...actualSummary,
    targetMaxFullFallbackCount: targetMax,
    targetRequired,
    targetMet,
    results
  };
}

export function validateTestEvidenceManifest({ manifest, repoRoot, tiers }) {
  const root = assertExactKeys(manifest, [
    "affected_selector_replay",
    "schema",
    "subprocess_startup_sites",
    "version"
  ], "test evidence manifest");
  if (root.schema !== TEST_EVIDENCE_SCHEMA || root.version !== 1) {
    fail(`test evidence manifest must use ${TEST_EVIDENCE_SCHEMA} version 1`);
  }
  return {
    subprocess: validateSubprocessEvidence(
      root.subprocess_startup_sites,
      repoRoot
    ),
    affectedReplay: validateAffectedReplay(root.affected_selector_replay, {
      repoRoot,
      tiers
    })
  };
}

function validateWitnesses(value, { repoRoot, tiers }) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("public contract witnesses must be a non-empty array");
  }
  const witnesses = new Map();
  let previousId = "";
  for (const [index, valueEntry] of value.entries()) {
    const label = `public contract witness ${index}`;
    const entry = assertExactKeys(valueEntry, [
      "id",
      "needle",
      "path",
      "tier"
    ], label);
    const id = assertString(entry.id, `${label} id`);
    if (id <= previousId) {
      fail("public contract witnesses must be sorted by unique id");
    }
    previousId = id;
    const repositoryPath = assertRepositoryPath(entry.path, `${label} path`);
    if (!["fast", "integration"].includes(entry.tier)) {
      fail(`${label} tier must be fast or integration`);
    }
    if (!tiers[entry.tier].includes(repositoryPath)) {
      fail(`${label} path is not in the declared ${entry.tier} tier`);
    }
    const needle = assertString(entry.needle, `${label} needle`);
    if (!readRepositoryFile(repoRoot, repositoryPath).includes(needle)) {
      fail(`${label} needle is missing from ${repositoryPath}`);
    }
    witnesses.set(id, { ...entry, path: repositoryPath });
  }
  return witnesses;
}

function validateAuthorityPaths(paths, label, repoRoot) {
  assertPathArray(paths, label);
  for (const repositoryPath of paths) {
    readRepositoryFile(repoRoot, repositoryPath);
  }
}

function validateWitnessReferences(ids, label, witnesses, usedWitnesses) {
  assertUniqueStrings(ids, label, { sorted: true });
  for (const id of ids) {
    if (!witnesses.has(id)) {
      fail(`${label} references unknown witness ${id}`);
    }
    usedWitnesses.add(id);
  }
}

function assertSourcePattern(repoRoot, repositoryPath, pattern, label) {
  if (!pattern.test(readRepositoryFile(repoRoot, repositoryPath))) {
    fail(`${label} is missing from ${repositoryPath}`);
  }
}

function validatePublicContracts(value, {
  repoRoot,
  witnesses,
  usedWitnesses
}) {
  const contracts = assertExactKeys(value, [
    "cli_json",
    "list_action",
    "openclaw_tools",
    "store_protocols"
  ], "public contracts");

  const cli = assertExactKeys(contracts.cli_json, [
    "authority_paths",
    "commands",
    "executable",
    "facade_exports",
    "package_name",
    "witnesses"
  ], "CLI JSON contract");
  if (cli.package_name !== "@scotthuang/agent-knock-knock" ||
      cli.executable !== "agent-knock-knock") {
    fail("CLI JSON package/executable contract changed");
  }
  assertExactArray(
    cli.facade_exports,
    ["parseCliCommand", "executeCliCommand"],
    "CLI JSON facade_exports"
  );
  assertExactArray(cli.commands, PUBLIC_COMMANDS, "CLI JSON commands");
  validateAuthorityPaths(cli.authority_paths, "CLI JSON authority_paths", repoRoot);
  validateWitnessReferences(
    cli.witnesses,
    "CLI JSON witnesses",
    witnesses,
    usedWitnesses
  );
  const packageJson = readJson(repoRoot, "package.json");
  if (packageJson.name !== cli.package_name ||
      packageJson.bin?.[cli.executable] !== "dist/src/cli.js") {
    fail("package.json no longer matches the CLI JSON package/executable contract");
  }
  assertSourcePattern(
    repoRoot,
    "src/cli-core.ts",
    /export function parseCliCommand\s*\(/u,
    "parseCliCommand facade export"
  );
  assertSourcePattern(
    repoRoot,
    "src/cli-core.ts",
    /export async function executeCliCommand\s*\(/u,
    "executeCliCommand facade export"
  );

  const actions = assertExactKeys(contracts.list_action, [
    "actions",
    "authority_paths",
    "version",
    "witnesses"
  ], "list action contract");
  if (actions.version !== 16) {
    fail("list action contract version must remain 16");
  }
  assertExactArray(actions.actions, PUBLIC_ACTIONS, "list action names");
  validateAuthorityPaths(
    actions.authority_paths,
    "list action authority_paths",
    repoRoot
  );
  validateWitnessReferences(
    actions.witnesses,
    "list action witnesses",
    witnesses,
    usedWitnesses
  );
  assertSourcePattern(
    repoRoot,
    "src/terminal-list-renderer.ts",
    /version:\s*16\b/u,
    "list action contract version 16"
  );

  const openclaw = assertExactKeys(contracts.openclaw_tools, [
    "authority_paths",
    "plugin_id",
    "slash_command",
    "tools",
    "witnesses"
  ], "OpenClaw tool contract");
  if (openclaw.plugin_id !== "agent-knock-knock" ||
      openclaw.slash_command !== "akk") {
    fail("OpenClaw plugin id or slash command changed");
  }
  assertExactArray(openclaw.tools, OPENCLAW_TOOLS, "OpenClaw tools");
  validateAuthorityPaths(
    openclaw.authority_paths,
    "OpenClaw authority_paths",
    repoRoot
  );
  validateWitnessReferences(
    openclaw.witnesses,
    "OpenClaw witnesses",
    witnesses,
    usedWitnesses
  );
  const pluginManifest = readJson(repoRoot, "openclaw.plugin.json");
  if (pluginManifest.id !== openclaw.plugin_id ||
      pluginManifest.commandAliases?.[0]?.name !== openclaw.slash_command) {
    fail("openclaw.plugin.json no longer matches the plugin identity contract");
  }
  assertExactArray(
    pluginManifest.contracts?.tools,
    OPENCLAW_TOOLS,
    "openclaw.plugin.json contract tools"
  );

  const store = assertExactKeys(contracts.store_protocols, [
    "authority_paths",
    "current_writer_protocol",
    "format_version",
    "protocol_witnesses",
    "session_authority_protocol",
    "upgradeable_writer_protocols",
    "witnesses"
  ], "Store protocol contract");
  if (store.format_version !== 1 ||
      store.current_writer_protocol !== 5 ||
      store.session_authority_protocol !== 3) {
    fail("Store format/writer/session-authority protocol contract changed");
  }
  assertExactArray(
    store.upgradeable_writer_protocols,
    [1, 2, 3, 4],
    "Store upgradeable_writer_protocols"
  );
  validateAuthorityPaths(store.authority_paths, "Store authority_paths", repoRoot);
  validateWitnessReferences(
    store.witnesses,
    "Store witnesses",
    witnesses,
    usedWitnesses
  );
  if (!Array.isArray(store.protocol_witnesses) ||
      store.protocol_witnesses.length !== 5) {
    fail("Store protocol_witnesses must cover writer protocols 1 through 5");
  }
  for (const [index, valueEntry] of store.protocol_witnesses.entries()) {
    const entry = assertExactKeys(valueEntry, ["protocol", "witness"],
      `Store protocol witness ${index}`);
    if (entry.protocol !== index + 1) {
      fail("Store protocol_witnesses must be ordered 1 through 5");
    }
    validateWitnessReferences(
      [entry.witness],
      `Store protocol ${entry.protocol} witness`,
      witnesses,
      usedWitnesses
    );
  }
  const storeSource = readRepositoryFile(repoRoot, "src/store.ts");
  for (const [name, expected] of [
    ["STORE_FORMAT_VERSION", 1],
    ["STORE_WRITER_PROTOCOL", 5],
    ["STORE_SESSION_AUTHORITY_PROTOCOL", 3]
  ]) {
    if (!new RegExp(`export const ${name} = ${expected};`, "u").test(storeSource)) {
      fail(`${name}=${expected} is missing from src/store.ts`);
    }
  }
  if (!/STORE_UPGRADEABLE_WRITER_PROTOCOLS = new Set\(\[1, 2, 3, 4\]\)/u
    .test(storeSource)) {
    fail("Store upgradeable writer protocol set changed");
  }
}

function validateMigrationMappings(value, { witnesses, usedWitnesses }) {
  if (!Array.isArray(value)) {
    fail("migration_witnesses must be an array");
  }
  const ids = [];
  for (const [index, valueEntry] of value.entries()) {
    const label = `migration witness mapping ${index}`;
    const entry = assertExactKeys(valueEntry, [
      "id",
      "invariant",
      "old_executable_witnesses",
      "retained_boundary_witnesses",
      "service_invariant_witnesses"
    ], label);
    ids.push(assertString(entry.id, `${label} id`));
    assertString(entry.invariant, `${label} invariant`);
    for (const [field, expectedTier] of [
      ["old_executable_witnesses", "integration"],
      ["service_invariant_witnesses", "fast"],
      ["retained_boundary_witnesses", "integration"]
    ]) {
      validateWitnessReferences(
        entry[field],
        `${label} ${field}`,
        witnesses,
        usedWitnesses
      );
      if (entry[field].length === 0) {
        fail(`${label} ${field} must not be empty`);
      }
      for (const witnessId of entry[field]) {
        if (witnesses.get(witnessId).tier !== expectedTier) {
          fail(`${label} ${field} witness ${witnessId} must be ${expectedTier}`);
        }
      }
    }
  }
  assertExactArray(ids, MIGRATION_IDS, "migration witness mapping ids");
}

export function validatePublicContractManifest({ manifest, repoRoot, tiers }) {
  const root = assertExactKeys(manifest, [
    "contracts",
    "migration_witnesses",
    "schema",
    "version",
    "witnesses"
  ], "public contract witness manifest");
  if (root.schema !== PUBLIC_CONTRACT_SCHEMA || root.version !== 1) {
    fail(`public contract manifest must use ${PUBLIC_CONTRACT_SCHEMA} version 1`);
  }
  const witnesses = validateWitnesses(root.witnesses, { repoRoot, tiers });
  const usedWitnesses = new Set();
  validatePublicContracts(root.contracts, {
    repoRoot,
    witnesses,
    usedWitnesses
  });
  validateMigrationMappings(root.migration_witnesses, {
    witnesses,
    usedWitnesses
  });
  const unused = [...witnesses.keys()].filter((id) => !usedWitnesses.has(id));
  if (unused.length > 0) {
    fail(`public contract witnesses are unreferenced: ${unused.join(", ")}`);
  }
  return {
    contractCount: Object.keys(root.contracts).length,
    witnessCount: witnesses.size,
    migrationCount: root.migration_witnesses.length,
    openclawToolCount: root.contracts.openclaw_tools.tools.length,
    storeProtocolCount: root.contracts.store_protocols.protocol_witnesses.length
  };
}

export function loadAndValidateRefactorEvidence({ repoRoot, tiers }) {
  const testEvidence = validateTestEvidenceManifest({
    manifest: readJson(repoRoot, TEST_EVIDENCE_MANIFEST_PATH),
    repoRoot,
    tiers
  });
  const publicContracts = validatePublicContractManifest({
    manifest: readJson(repoRoot, PUBLIC_CONTRACT_MANIFEST_PATH),
    repoRoot,
    tiers
  });
  const dynamicSubprocess = loadDynamicSubprocessEvidenceConfig({ repoRoot });
  return { dynamicSubprocess, testEvidence, publicContracts };
}

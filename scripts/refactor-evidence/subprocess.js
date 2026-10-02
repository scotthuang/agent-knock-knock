import {
  fail,
  assertExactKeys,
  assertString,
  assertInteger,
  assertBoolean,
  enforceRequiredFinalThreshold,
  assertExactArray
} from "./common.js";
import {
  revisionTestSources,
  worktreeTestSources
} from "./revision-sources.js";

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

const STATIC_SUBPROCESS_DIAGNOSTIC_PATHS = Object.freeze([
  "test/refactor-evidence.test.ts"
]);

const STATIC_SUBPROCESS_BASELINE_REVISION =
  "ea592a88d7af4a709e7a7a1b989dd29e61932935";

const STATIC_SUBPROCESS_MAXIMUM_PERCENT_OF_BASELINE = 40;

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

export function measureStaticSubprocessStartupSites(sources) {
  const diagnosticPaths = new Set(STATIC_SUBPROCESS_DIAGNOSTIC_PATHS);
  const productSources = [];
  const diagnosticSources = [];
  for (const source of sources) {
    (diagnosticPaths.has(source.path)
      ? diagnosticSources
      : productSources).push(source);
  }
  return {
    product: countStaticSubprocessStartupSites(productSources),
    diagnostic: countStaticSubprocessStartupSites(diagnosticSources)
  };
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

export function validateSubprocessEvidence(value, repoRoot) {
  const evidence = assertExactKeys(value, [
    "baseline",
    "current",
    "final_threshold",
    "measurement"
  ], "test evidence subprocess_startup_sites");
  const measurement = assertExactKeys(evidence.measurement, [
    "call_expressions",
    "diagnostic_excluded_paths",
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
  assertExactArray(
    measurement.diagnostic_excluded_paths,
    STATIC_SUBPROCESS_DIAGNOSTIC_PATHS,
    "subprocess measurement diagnostic_excluded_paths"
  );
  if (measurement.lookahead_characters !== LOOKAHEAD_CHARACTERS) {
    fail(`subprocess measurement lookahead_characters must be ${LOOKAHEAD_CHARACTERS}`);
  }

  const baseline = assertExactKeys(evidence.baseline, [
    "counts",
    "diagnostic_counts",
    "diagnostic_included_total",
    "included_total",
    "revision"
  ], "subprocess baseline");
  const revision = assertString(baseline.revision, "subprocess baseline revision");
  if (revision !== STATIC_SUBPROCESS_BASELINE_REVISION) {
    fail(
      "subprocess baseline revision must remain " +
      STATIC_SUBPROCESS_BASELINE_REVISION
    );
  }
  const baselineCounts = validateCounts(baseline.counts, "subprocess baseline counts");
  const baselineDiagnosticCounts = validateCounts(
    baseline.diagnostic_counts,
    "subprocess baseline diagnostic counts"
  );
  if (baseline.included_total !== includedStartupTotal(baselineCounts)) {
    fail("subprocess baseline included_total does not match its category counts");
  }
  if (baseline.diagnostic_included_total !==
      includedStartupTotal(baselineDiagnosticCounts)) {
    fail(
      "subprocess baseline diagnostic_included_total does not match its " +
      "diagnostic category counts"
    );
  }

  const current = assertExactKeys(evidence.current, [
    "counts",
    "diagnostic_counts",
    "diagnostic_included_total",
    "included_total"
  ], "subprocess current");
  const currentCounts = validateCounts(current.counts, "subprocess current counts");
  const currentDiagnosticCounts = validateCounts(
    current.diagnostic_counts,
    "subprocess current diagnostic counts"
  );
  if (current.included_total !== includedStartupTotal(currentCounts)) {
    fail("subprocess current included_total does not match its category counts");
  }
  if (current.diagnostic_included_total !==
      includedStartupTotal(currentDiagnosticCounts)) {
    fail(
      "subprocess current diagnostic_included_total does not match its " +
      "diagnostic category counts"
    );
  }

  const target = assertExactKeys(evidence.final_threshold, [
    "maximum_percent_of_baseline",
    "required"
  ], "subprocess final_threshold");
  const targetPercent = assertInteger(
    target.maximum_percent_of_baseline,
    "subprocess final_threshold maximum_percent_of_baseline"
  );
  if (targetPercent !== STATIC_SUBPROCESS_MAXIMUM_PERCENT_OF_BASELINE) {
    fail(
      "subprocess final_threshold maximum_percent_of_baseline must be " +
      STATIC_SUBPROCESS_MAXIMUM_PERCENT_OF_BASELINE
    );
  }
  const targetRequired = assertBoolean(
    target.required,
    "subprocess final_threshold required"
  );
  if (targetRequired !== true) {
    fail("subprocess final_threshold required must be true");
  }

  const historical = revisionTestSources(repoRoot, revision);
  if (historical.revision !== revision) {
    fail(
      `subprocess baseline revision must be the full immutable commit id ` +
      `(resolved ${historical.revision})`
    );
  }
  const measuredBaseline = measureStaticSubprocessStartupSites(
    historical.sources
  );
  const measuredCurrent = measureStaticSubprocessStartupSites(
    worktreeTestSources(repoRoot)
  );
  assertCounts(
    measuredBaseline.product,
    baselineCounts,
    "subprocess baseline counts"
  );
  assertCounts(
    measuredBaseline.diagnostic,
    baselineDiagnosticCounts,
    "subprocess baseline diagnostic counts"
  );
  assertCounts(
    measuredCurrent.product,
    currentCounts,
    "subprocess current counts"
  );
  assertCounts(
    measuredCurrent.diagnostic,
    currentDiagnosticCounts,
    "subprocess current diagnostic counts"
  );

  const baselineIncluded = includedStartupTotal(measuredBaseline.product);
  const currentIncluded = includedStartupTotal(measuredCurrent.product);
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
    baselineCounts: measuredBaseline.product,
    baselineDiagnosticCounts: measuredBaseline.diagnostic,
    baselineDiagnosticIncluded:
      includedStartupTotal(measuredBaseline.diagnostic),
    baselineIncluded,
    currentCounts: measuredCurrent.product,
    currentDiagnosticCounts: measuredCurrent.diagnostic,
    currentDiagnosticIncluded:
      includedStartupTotal(measuredCurrent.diagnostic),
    currentIncluded,
    reductionBasisPoints: baselineIncluded === 0
      ? 0
      : Math.round(((baselineIncluded - currentIncluded) * 10_000) / baselineIncluded),
    targetMaximumPercent: targetPercent,
    targetRequired,
    targetMet
  };
}

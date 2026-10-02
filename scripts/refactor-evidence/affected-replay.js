import {
  analyzeRevisionChangeSemantics,
  selectAffectedTests
} from "../affected-test-selection.js";
import {
  loadAndValidateProductionModuleOwnership
} from "../production-module-ownership.js";
import {
  fail,
  assertObject,
  assertExactKeys,
  assertString,
  assertInteger,
  assertBoolean,
  enforceRequiredFinalThreshold,
  assertExactArray,
  assertPathArray
} from "./common.js";
import {
  readCommitSummaryAndPaths
} from "./revision-sources.js";

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
    assertPathArray(
      expected.integration_files,
      `${label} expected integration_files`,
      { sorted: false }
    );
  } else {
    fail(`${label} expected mode must be full or targeted`);
  }
  return scenario;
}

export function validateAffectedReplay(value, { repoRoot, tiers }) {
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
  if (targetMax !== 2) {
    fail("affected selector final_threshold maximum_full_fallback_count must be 2");
  }
  if (targetRequired !== true) {
    fail("affected selector final_threshold required must be true");
  }
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
    const historical = readCommitSummaryAndPaths(repoRoot, scenario.commit);
    if (historical.commit !== scenario.commit) {
      fail(`affected selector scenario ${index} commit is not immutable`);
    }
    if (historical.subject !== scenario.subject) {
      fail(
        `affected selector scenario ${index} subject expected ` +
        `${JSON.stringify(scenario.subject)} but found ` +
        `${JSON.stringify(historical.subject)}`
      );
    }
    assertExactArray(
      historical.paths,
      scenario.paths,
      `affected selector scenario ${index} historical paths`
    );
    const selection = selectAffectedTests(historical.paths, tiers, {
      productionOwnership: ownership,
      changeSemantics: analyzeRevisionChangeSemantics({
        repoRoot,
        changedPaths: historical.paths,
        beforeRevision: `${scenario.commit}^`,
        afterRevision: scenario.commit
      })
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

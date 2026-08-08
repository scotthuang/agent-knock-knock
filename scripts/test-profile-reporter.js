import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function relativeTestFile(file) {
  if (!file) {
    return "unknown";
  }
  return path.relative(process.cwd(), file)
    .split(path.sep)
    .join("/")
    .replace(/^dist\/test\//u, "test/")
    .replace(/\.js$/u, ".ts");
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export default async function* profileReporter(source) {
  const tests = [];
  const fileSummaries = new Map();
  let overallSummary;
  let completed = 0;

  for await (const event of source) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      const data = event.data;
      if (data.details?.type !== "suite" && !data.skip && !data.todo) {
        tests.push({
          file: relativeTestFile(data.file),
          name: data.name,
          nesting: data.nesting,
          duration_ms: data.details.duration_ms,
          status: event.type === "test:pass" ? "passed" : "failed",
          ...(event.type === "test:fail"
            ? {
                error: data.details.error?.message ?? String(data.details.error),
                stack: data.details.error?.stack ?? null
              }
            : {})
        });
        completed += 1;
        if (completed % 25 === 0) {
          yield ".";
        }
      }
    }
    if (event.type === "test:summary") {
      const data = event.data;
      if (data.file) {
        fileSummaries.set(relativeTestFile(data.file), {
          duration_ms: data.duration_ms,
          success: data.success,
          counts: data.counts
        });
      } else {
        overallSummary = data;
      }
    }
  }

  const testsByFile = new Map();
  for (const record of tests) {
    const records = testsByFile.get(record.file) ?? [];
    records.push(record);
    testsByFile.set(record.file, records);
  }
  const files = [...new Set([...fileSummaries.keys(), ...testsByFile.keys()])]
    .map((file) => {
      const records = testsByFile.get(file) ?? [];
      const summary = fileSummaries.get(file);
      return {
        file,
        duration_ms: summary?.duration_ms ?? records.reduce(
          (total, record) => total + record.duration_ms,
          0
        ),
        tests: records.length,
        success: summary?.success ?? records.every((record) => record.status === "passed")
      };
    })
    .sort((left, right) => right.duration_ms - left.duration_ms);
  const slowTests = [...tests]
    .sort((left, right) => right.duration_ms - left.duration_ms)
    .slice(0, 30);
  const durations = files.map((file) => file.duration_ms);
  const report = {
    generated_at: new Date().toISOString(),
    tier: process.env.AKK_TEST_PROFILE_TIER ?? "unknown",
    commit: process.env.AKK_TEST_PROFILE_COMMIT ?? "unknown",
    dirty: process.env.AKK_TEST_PROFILE_DIRTY === "1",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_count: os.availableParallelism(),
    concurrency: process.env.AKK_TEST_CONCURRENCY ?? "node-default",
    compile_cache: process.env.NODE_COMPILE_CACHE ?? null,
    success: overallSummary?.success ?? files.every((file) => file.success),
    duration_ms: overallSummary?.duration_ms ?? 0,
    counts: overallSummary?.counts ?? null,
    file_duration_ms: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length > 0 ? Math.max(...durations) : 0
    },
    files,
    tests,
    slow_tests: slowTests
  };

  const outputPath = process.env.AKK_TEST_PROFILE_OUTPUT;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  yield "\n\nAKK test profile\n";
  yield `${JSON.stringify({
    tier: report.tier,
    success: report.success,
    duration_ms: Math.round(report.duration_ms),
    files: files.length,
    tests: tests.length,
    file_p50_ms: Math.round(report.file_duration_ms.p50),
    file_p95_ms: Math.round(report.file_duration_ms.p95),
    file_max_ms: Math.round(report.file_duration_ms.max),
    output: outputPath ?? null
  }, null, 2)}\n`;
  yield "Slowest files:\n";
  for (const file of files.slice(0, 20)) {
    yield `${file.duration_ms.toFixed(1).padStart(10)} ms  ${String(file.tests).padStart(4)} tests  ${file.file}\n`;
  }
  yield "Slowest tests:\n";
  for (const record of slowTests.slice(0, 20)) {
    yield `${record.duration_ms.toFixed(1).padStart(10)} ms  ${record.file} :: ${record.name}\n`;
  }
  const failures = tests.filter((record) => record.status === "failed");
  if (failures.length > 0) {
    yield "Failed tests:\n";
    for (const record of failures) {
      yield `${record.file} :: ${record.name}\n${record.stack ?? record.error ?? "unknown failure"}\n`;
    }
  }
}

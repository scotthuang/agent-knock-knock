import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const DYNAMIC_SUBPROCESS_EVIDENCE_CONFIG =
  "config/subprocess-dynamic-evidence.json";

function resolveThroughExistingAncestor(value) {
  let current = path.resolve(value);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function repositoryContainsPath(repoRoot, candidatePath) {
  const root = resolveThroughExistingAncestor(repoRoot);
  const candidate = resolveThroughExistingAncestor(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

const CONFIG_SCHEMA = "agent-knock-knock/dynamic-subprocess-evidence";
const TRACE_SCHEMA = "agent-knock-knock/subprocess-trace";
const TRACE_VERSION = 1;
const IMMUTABLE_BASELINE =
  "ea592a88d7af4a709e7a7a1b989dd29e61932935";
const METHODS = Object.freeze([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync"
]);
const ASYNC_METHODS = new Set(["exec", "execFile", "fork", "spawn"]);
const REQUIRED_BOUNDARIES = Object.freeze({
  argv_exit: ["outer_cli_argv", "outer_cli_nonzero_exit"],
  claude_adapter: ["command_start"],
  crash: ["outer_cli_exit_code"],
  gateway: ["command_start"],
  lock: ["outer_cli_overlap"],
  pid: ["outer_cli_live_pid", "outer_cli_signal"],
  terminal_adapters: [
    "command_start",
    "command_start",
    "command_start"
  ]
});
const CANONICAL_BOUNDARY_WITNESSES = Object.freeze({
  argv_exit: Object.freeze({
    path: "test/cli-ux.test.ts",
    needle: "doctor exits non-zero when required package files are missing"
  }),
  claude_adapter: Object.freeze({
    path: "test/shards/agent-cli-composer-replay.test.ts",
    needle: "raw background send durably prepares its terminal submission before tmux accepts it"
  }),
  crash: Object.freeze({
    path: "test/codex-no-rollout-binding-cli.test.ts",
    needle: "zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry"
  }),
  gateway: Object.freeze({
    path: "test/callback-cli.test.ts",
    needle: "concurrent callback retries claim one attempt and report the winner in flight"
  }),
  lock: Object.freeze({
    path: "test/shards/agent-cli-control-locks.test.ts",
    needle: "managed terminal send cannot overwrite a concurrent terminal cancellation"
  }),
  pid: Object.freeze({
    path: "test/shards/agent-cli-monitor-recovery.test.ts",
    needle: "terminal bridge monitor singleton rejects a live owner and reclaims a dead owner"
  }),
  terminal_adapters: Object.freeze({
    path: "test/shards/agent-cli-composer-replay.test.ts",
    needle: "raw background send durably prepares its terminal submission before tmux accepts it"
  })
});
const ALLOWED_EVIDENCE_TEST_NAMES = new Set([
  ...new Set(Object.values(CANONICAL_BOUNDARY_WITNESSES).map(
    (witness) => witness.needle
  )),
  "zero-input deferred source reservation recovery aborts safely before one refreshed retry",
  "zero-input deferred target preparation recovery aborts safely before one refreshed retry",
  "zero-input deferred prepared ledger before Turn state recovery aborts safely before one refreshed retry",
  "dynamic shell descendant evidence probe"
]);

function fail(message) {
  throw new Error(message);
}

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const object = objectValue(value, label);
  const expected = [...keys].sort();
  const actual = Object.keys(object).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    fail([
      missing.length > 0 ? `${label} missing keys: ${missing.join(", ")}` : "",
      unknown.length > 0 ? `${label} has unexpected keys: ${unknown.join(", ")}` : ""
    ].filter(Boolean).join("; "));
  }
  return object;
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value, label) {
  if (value !== null && typeof value !== "string") {
    fail(`${label} must be a string or null`);
  }
  return value;
}

function callIdValue(value, label) {
  const callId = stringValue(value, label);
  if (!/^[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{8}$/u.test(callId)) {
    fail(`${label} is malformed`);
  }
  return callId;
}

function nullableCallId(value, label) {
  if (value === null) return null;
  return callIdValue(value, label);
}

function integerValue(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function nullableInteger(value, label) {
  if (value !== null && !Number.isSafeInteger(value)) {
    fail(`${label} must be an integer or null`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || entry.length === 0
  )) {
    fail(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} contains duplicate entries`);
  }
  return value;
}

function repositoryPath(value, label) {
  const repositoryPathValue = stringValue(value, label);
  if (repositoryPathValue.startsWith("/") ||
      repositoryPathValue.startsWith("./") ||
      repositoryPathValue.includes("\\") ||
      repositoryPathValue.split("/").includes("..")) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return repositoryPathValue;
}

function readJson(absolutePath, label) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(`${label} cannot be read: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function resolveCommit(repoRoot, revision) {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`cannot resolve dynamic subprocess baseline ${revision}`);
  }
  return String(result.stdout).trim();
}

function validateRequirement(value, boundaryLabel, index) {
  const label = `${boundaryLabel} requirement ${index}`;
  const object = objectValue(value, label);
  const kind = stringValue(object.kind, `${label}.kind`);
  if (kind === "outer_cli_argv") {
    exactKeys(object, ["action", "kind", "minimum", "required_options"], label);
    stringValue(object.action, `${label}.action`);
    integerValue(object.minimum, `${label}.minimum`, 1);
    stringArray(object.required_options, `${label}.required_options`);
  } else if (kind === "outer_cli_nonzero_exit" ||
      kind === "outer_cli_live_pid") {
    exactKeys(object, ["kind", "minimum"], label);
    integerValue(object.minimum, `${label}.minimum`, 1);
  } else if (kind === "outer_cli_exit_code") {
    exactKeys(object, ["code", "kind", "minimum"], label);
    integerValue(object.code, `${label}.code`, 1);
    integerValue(object.minimum, `${label}.minimum`, 1);
  } else if (kind === "outer_cli_signal") {
    exactKeys(object, ["kind", "minimum", "signal"], label);
    stringValue(object.signal, `${label}.signal`);
    integerValue(object.minimum, `${label}.minimum`, 1);
  } else if (kind === "outer_cli_overlap") {
    exactKeys(object, ["kind", "minimum_concurrent"], label);
    integerValue(
      object.minimum_concurrent,
      `${label}.minimum_concurrent`,
      2
    );
  } else if (kind === "command_start") {
    exactKeys(object, ["command", "kind", "minimum"], label);
    stringValue(object.command, `${label}.command`);
    integerValue(object.minimum, `${label}.minimum`, 1);
  } else {
    fail(`${label}.kind is unsupported: ${JSON.stringify(kind)}`);
  }
  return object;
}

export function validateRetainedBoundaries(
  value,
  { repoRoot, integrationTests }
) {
  if (!Array.isArray(value)) {
    fail("retained_boundaries must be an array");
  }
  const expectedIds = Object.keys(REQUIRED_BOUNDARIES);
  const actualIds = value.map((entry, index) =>
    stringValue(objectValue(entry, `retained boundary ${index}`).id,
      `retained boundary ${index}.id`)
  );
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    fail(`retained boundary ids must equal ${JSON.stringify(expectedIds)}`);
  }

  return value.map((valueEntry, index) => {
    const label = `retained boundary ${valueEntry.id}`;
    const entry = exactKeys(valueEntry, [
      "id",
      "needle",
      "path",
      "requirements"
    ], label);
    const witnessPath = repositoryPath(entry.path, `${label}.path`);
    const canonicalWitness = CANONICAL_BOUNDARY_WITNESSES[entry.id];
    if (witnessPath !== canonicalWitness.path ||
        entry.needle !== canonicalWitness.needle) {
      fail(`${label} must keep its canonical path and test name`);
    }
    if (!integrationTests.has(witnessPath)) {
      fail(`${label}.path must be an integration-tier test`);
    }
    const needle = stringValue(entry.needle, `${label}.needle`);
    const absolutePath = path.join(repoRoot, witnessPath);
    if (!fs.existsSync(absolutePath) ||
        !fs.readFileSync(absolutePath, "utf8").includes(needle)) {
      fail(`${label} witness needle is missing from ${witnessPath}`);
    }
    if (!Array.isArray(entry.requirements)) {
      fail(`${label}.requirements must be an array`);
    }
    const requirements = entry.requirements.map((requirement, requirementIndex) =>
      validateRequirement(requirement, label, requirementIndex)
    );
    const expectedKinds = REQUIRED_BOUNDARIES[entry.id];
    const actualKinds = requirements.map((requirement) => requirement.kind);
    if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
      fail(`${label} requirement kinds must equal ${JSON.stringify(expectedKinds)}`);
    }
    let canonical = false;
    if (entry.id === "argv_exit") {
      canonical = requirements[0].action === "doctor" &&
        JSON.stringify(requirements[0].required_options) ===
          JSON.stringify(["--openclaw-bin", "--timeout-ms"]);
    } else if (entry.id === "claude_adapter") {
      canonical = requirements[0].command === "claude";
    } else if (entry.id === "crash") {
      canonical = requirements[0].code === 86;
    } else if (entry.id === "gateway") {
      canonical = requirements[0].command === "openclaw";
    } else if (entry.id === "lock") {
      canonical = requirements[0].minimum_concurrent >= 2;
    } else if (entry.id === "pid") {
      canonical = requirements[1].signal === "SIGKILL";
    } else if (entry.id === "terminal_adapters") {
      canonical = JSON.stringify(
        requirements.map((requirement) => requirement.command)
      ) === JSON.stringify(["tmux", "ps", "lsof"]);
    }
    if (!canonical) {
      fail(`${label} changed its canonical real-process requirement`);
    }
    return { ...entry, requirements };
  });
}

export function loadDynamicSubprocessEvidenceConfig({ repoRoot }) {
  const configPath = path.join(repoRoot, DYNAMIC_SUBPROCESS_EVIDENCE_CONFIG);
  const root = exactKeys(readJson(configPath, DYNAMIC_SUBPROCESS_EVIDENCE_CONFIG), [
    "baseline",
    "final_threshold",
    "measurement",
    "retained_boundaries",
    "schema",
    "version"
  ], "dynamic subprocess evidence config");
  if (root.schema !== CONFIG_SCHEMA || root.version !== 1) {
    fail(`dynamic subprocess evidence config must use ${CONFIG_SCHEMA} version 1`);
  }

  const measurement = exactKeys(root.measurement, [
    "concurrency",
    "dependency_lock",
    "drain_poll_ms",
    "drain_timeout_ms",
    "kind",
    "preload",
    "runner",
    "tier"
  ], "dynamic subprocess measurement");
  if (measurement.kind !== "preloaded_process_tree_runtime_trace" ||
      measurement.tier !== "full" ||
      measurement.concurrency !== 4 ||
      measurement.dependency_lock !== "package-lock.json" ||
      measurement.preload !== "scripts/subprocess-dynamic-hook.cjs" ||
      measurement.runner !== "scripts/run-test-tier.js") {
    fail("dynamic subprocess measurement must trace the full runtime process tree");
  }
  integerValue(measurement.concurrency, "dynamic subprocess concurrency", 1);
  integerValue(measurement.drain_poll_ms, "dynamic subprocess drain poll", 1);
  integerValue(
    measurement.drain_timeout_ms,
    "dynamic subprocess drain timeout",
    measurement.drain_poll_ms
  );
  for (const field of ["dependency_lock", "preload", "runner"]) {
    repositoryPath(measurement[field], `dynamic subprocess measurement.${field}`);
    if (!fs.existsSync(path.join(repoRoot, measurement[field]))) {
      fail(`dynamic subprocess measurement.${field} is missing`);
    }
  }

  const baseline = exactKeys(
    root.baseline,
    ["revision"],
    "dynamic subprocess baseline"
  );
  const revision = stringValue(baseline.revision, "dynamic subprocess baseline.revision");
  const resolved = resolveCommit(repoRoot, revision);
  if (resolved !== revision || revision !== IMMUTABLE_BASELINE) {
    fail("dynamic subprocess baseline revision must be a full immutable commit id");
  }

  const threshold = exactKeys(root.final_threshold, [
    "maximum_percent_of_baseline"
  ], "dynamic subprocess final threshold");
  const maximumPercent = integerValue(
    threshold.maximum_percent_of_baseline,
    "dynamic subprocess final_threshold.maximum_percent_of_baseline",
    0
  );
  if (maximumPercent > 40) {
    fail("dynamic subprocess final threshold must require at least a 60% reduction");
  }

  const tiers = readJson(
    path.join(repoRoot, "test/test-tiers.json"),
    "test/test-tiers.json"
  );
  const integrationTests = new Set(stringArray(
    objectValue(tiers, "test tiers").integration,
    "test tiers.integration"
  ));
  const retainedBoundaries = validateRetainedBoundaries(
    root.retained_boundaries,
    { repoRoot, integrationTests }
  );

  return {
    ...root,
    baseline: { ...baseline, revision: resolved },
    final_threshold: { maximum_percent_of_baseline: maximumPercent },
    measurement,
    retained_boundaries: retainedBoundaries
  };
}

function validateCommonEvent(event, label) {
  if (event.schema !== TRACE_SCHEMA || event.version !== TRACE_VERSION) {
    fail(`${label} has an unsupported trace schema`);
  }
  stringValue(event.run_id, `${label}.run_id`);
  integerValue(event.pid, `${label}.pid`, 1);
  integerValue(event.ppid, `${label}.ppid`, 0);
  integerValue(event.timestamp_ms, `${label}.timestamp_ms`, 0);
  nullableString(event.origin_test, `${label}.origin_test`);
  nullableString(event.origin_test_name, `${label}.origin_test_name`);
  if (event.origin_test_name !== null &&
      !ALLOWED_EVIDENCE_TEST_NAMES.has(event.origin_test_name)) {
    fail(`${label}.origin_test_name is not allowlisted`);
  }
}

function validateTraceEvent(value, index, expectedRunId) {
  const object = objectValue(value, `trace event ${index}`);
  const eventName = stringValue(object.event, `trace event ${index}.event`);
  let event;
  if (eventName === "process_boot") {
    event = exactKeys(object, [
      "action",
      "argument_count",
      "entry",
      "event",
      "option_names",
      "origin_test",
      "origin_test_name",
      "parent_call_id",
      "pid",
      "ppid",
      "role",
      "run_id",
      "schema",
      "timestamp_ms",
      "version"
    ], `trace event ${index}`);
    nullableString(event.action, `trace event ${index}.action`);
    integerValue(event.argument_count, `trace event ${index}.argument_count`, 0);
    nullableString(event.entry, `trace event ${index}.entry`);
    nullableCallId(
      event.parent_call_id,
      `trace event ${index}.parent_call_id`
    );
    stringArray(event.option_names, `trace event ${index}.option_names`);
    if (!["cli", "node", "other", "test"].includes(event.role)) {
      fail(`trace event ${index}.role is unsupported`);
    }
  } else if (eventName === "process_start") {
    event = exactKeys(object, [
      "action",
      "argument_count",
      "call_id",
      "child_pid",
      "command",
      "duration_ms",
      "detached",
      "error_code",
      "event",
      "exit_code",
      "method",
      "option_names",
      "origin_test",
      "origin_test_name",
      "pid",
      "ppid",
      "run_id",
      "schema",
      "signal",
      "started",
      "target_role",
      "timestamp_ms",
      "version"
    ], `trace event ${index}`);
    nullableString(event.action, `trace event ${index}.action`);
    integerValue(event.argument_count, `trace event ${index}.argument_count`, 0);
    callIdValue(event.call_id, `trace event ${index}.call_id`);
    nullableInteger(event.child_pid, `trace event ${index}.child_pid`);
    stringValue(event.command, `trace event ${index}.command`);
    integerValue(event.duration_ms, `trace event ${index}.duration_ms`, 0);
    booleanValue(event.detached, `trace event ${index}.detached`);
    nullableString(event.error_code, `trace event ${index}.error_code`);
    nullableInteger(event.exit_code, `trace event ${index}.exit_code`);
    if (!METHODS.includes(event.method)) {
      fail(`trace event ${index}.method is unsupported`);
    }
    stringArray(event.option_names, `trace event ${index}.option_names`);
    nullableString(event.signal, `trace event ${index}.signal`);
    booleanValue(event.started, `trace event ${index}.started`);
    if (!["cli", "node", "other"].includes(event.target_role)) {
      fail(`trace event ${index}.target_role is unsupported`);
    }
  } else if (eventName === "process_exit") {
    event = exactKeys(object, [
      "call_id",
      "child_pid",
      "event",
      "exit_code",
      "origin_test",
      "origin_test_name",
      "pid",
      "ppid",
      "run_id",
      "schema",
      "signal",
      "timestamp_ms",
      "version"
    ], `trace event ${index}`);
    callIdValue(event.call_id, `trace event ${index}.call_id`);
    integerValue(event.child_pid, `trace event ${index}.child_pid`, 1);
    nullableInteger(event.exit_code, `trace event ${index}.exit_code`);
    nullableString(event.signal, `trace event ${index}.signal`);
  } else {
    fail(`trace event ${index}.event is unsupported: ${JSON.stringify(eventName)}`);
  }
  validateCommonEvent(event, `trace event ${index}`);
  if (expectedRunId !== undefined && event.run_id !== expectedRunId) {
    fail(`trace event ${index} belongs to an unexpected run`);
  }
  return event;
}

export function readDynamicSubprocessTrace(traceDirectory, runId) {
  if (!path.isAbsolute(traceDirectory)) {
    fail("dynamic subprocess trace directory must be absolute");
  }
  const files = fs.readdirSync(traceDirectory)
    .filter((name) => /^trace-[0-9]+\.ndjson$/u.test(name))
    .sort();
  if (files.length === 0) {
    fail("dynamic subprocess trace contains no process logs");
  }
  const values = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(traceDirectory, file), "utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const [lineIndex, line] of lines.entries()) {
      try {
        values.push(JSON.parse(line));
      } catch {
        fail(`${file}:${lineIndex + 1} is not valid JSON`);
      }
    }
  }
  return values.map((value, index) =>
    validateTraceEvent(value, index, runId)
  );
}

function traceFingerprint(traceDirectory) {
  return fs.readdirSync(traceDirectory)
    .filter((name) => /^trace-[0-9]+\.ndjson$/u.test(name))
    .sort()
    .map((name) => {
      const stat = fs.statSync(path.join(traceDirectory, name));
      return `${name}:${stat.size}`;
    })
    .join("|");
}

function processGroupIsAlive(processGroup) {
  if (process.platform === "win32") {
    fail("dynamic subprocess process-group completion requires POSIX");
  }
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function observedProcessGroups(events, rootProcessGroup) {
  return [...new Set([
    rootProcessGroup,
    ...events.flatMap((event) =>
      event.event === "process_start" && event.started && event.detached &&
      event.child_pid !== null ? [event.child_pid] : []
    )
  ])]
    .sort((left, right) => left - right);
}

export async function waitForDynamicSubprocessTreeCompletion({
  traceDirectory,
  runId,
  rootProcessGroup,
  pollMs,
  timeoutMs,
  isProcessGroupAlive = processGroupIsAlive,
  sleep = delay,
  now = Date.now
}) {
  integerValue(rootProcessGroup, "dynamic subprocess root process group", 1);
  for (const [label, value, minimum] of [
    ["poll", pollMs, 1],
    ["timeout", timeoutMs, pollMs]
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      fail(`dynamic subprocess drain ${label} must be an integer >= ${minimum}`);
    }
  }
  const startedAt = now();
  let latestEvents = [];
  let latestLiveGroups = [];
  while (now() - startedAt <= timeoutMs) {
    latestEvents = readDynamicSubprocessTrace(traceDirectory, runId);
    const groups = observedProcessGroups(latestEvents, rootProcessGroup);
    latestLiveGroups = groups.filter(isProcessGroupAlive);
    if (latestLiveGroups.length === 0) {
      const fingerprint = traceFingerprint(traceDirectory);
      const confirmedEvents = readDynamicSubprocessTrace(traceDirectory, runId);
      const confirmedFingerprint = traceFingerprint(traceDirectory);
      const confirmedGroups = observedProcessGroups(
        confirmedEvents,
        rootProcessGroup
      );
      const confirmedLiveGroups = confirmedGroups.filter(isProcessGroupAlive);
      if (fingerprint === confirmedFingerprint &&
          confirmedLiveGroups.length === 0) {
        return confirmedEvents;
      }
      latestEvents = confirmedEvents;
      latestLiveGroups = confirmedLiveGroups;
    }
    await sleep(pollMs);
  }
  fail(
    "dynamic subprocess process tree did not complete before timeout" +
    (latestLiveGroups.length > 0
      ? `; live process groups: ${latestLiveGroups.join(", ")}`
      : "; completion could not be confirmed")
  );
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function maximumOverlap(intervals) {
  const points = intervals.flatMap((interval) => [
    { time: interval.start, delta: 1 },
    { time: interval.end, delta: -1 }
  ]).sort((left, right) =>
    left.time - right.time || left.delta - right.delta
  );
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function parentStart(pid, bootByPid, startByChildPid, startByCallId) {
  const bootCallId = bootByPid.get(pid)?.parent_call_id;
  return (bootCallId ? startByCallId.get(bootCallId) : undefined) ??
    startByChildPid.get(pid);
}

function processParent(pid, bootByPid, startByChildPid, startByCallId) {
  const start = parentStart(
    pid,
    bootByPid,
    startByChildPid,
    startByCallId
  );
  return start?.pid ?? bootByPid.get(pid)?.ppid;
}

function originatingStart(pid, bootByPid, startByChildPid, startByCallId) {
  const seen = new Set();
  let current = pid;
  while (Number.isSafeInteger(current) && current > 0 && !seen.has(current)) {
    seen.add(current);
    const start = parentStart(
      current,
      bootByPid,
      startByChildPid,
      startByCallId
    );
    if (start) return start;
    current = bootByPid.get(current)?.ppid;
  }
  return undefined;
}

function hasCliAncestor(pid, bootByPid, startByChildPid, startByCallId) {
  const seen = new Set([pid]);
  let current = processParent(
    pid,
    bootByPid,
    startByChildPid,
    startByCallId
  );
  while (Number.isSafeInteger(current) && current > 0 && !seen.has(current)) {
    seen.add(current);
    const boot = bootByPid.get(current);
    if (boot?.role === "cli") {
      return true;
    }
    current = processParent(
      current,
      bootByPid,
      startByChildPid,
      startByCallId
    );
  }
  return false;
}

function outerCliAncestorPid(pid, bootByPid, startByChildPid, startByCallId) {
  const seen = new Set();
  let current = pid;
  let outerCliPid = null;
  while (Number.isSafeInteger(current) && current > 0 && !seen.has(current)) {
    seen.add(current);
    if (bootByPid.get(current)?.role === "cli") {
      outerCliPid = current;
    }
    current = processParent(
      current,
      bootByPid,
      startByChildPid,
      startByCallId
    );
  }
  return outerCliPid;
}

function outcomeFor(start, exitByCallId) {
  const exit = exitByCallId.get(start?.call_id);
  return {
    exitCode: exit?.exit_code ?? start?.exit_code ?? null,
    signal: exit?.signal ?? start?.signal ?? null,
    end: exit?.timestamp_ms ?? (
      start ? start.timestamp_ms + start.duration_ms : null
    )
  };
}

export function summarizeDynamicSubprocessTrace(events, { runId } = {}) {
  const validated = events.map((event, index) =>
    validateTraceEvent(event, index, runId)
  );
  const bootByPid = new Map();
  const starts = [];
  const startByCallId = new Map();
  const startByChildPid = new Map();
  const exitByCallId = new Map();

  for (const event of validated) {
    if (event.event === "process_boot") {
      if (bootByPid.has(event.pid)) {
        fail(`dynamic subprocess trace repeats process boot pid ${event.pid}`);
      }
      bootByPid.set(event.pid, event);
    } else if (event.event === "process_start") {
      if (startByCallId.has(event.call_id)) {
        fail(`dynamic subprocess trace repeats call id ${event.call_id}`);
      }
      starts.push(event);
      startByCallId.set(event.call_id, event);
      if (event.started && event.child_pid !== null) {
        if (startByChildPid.has(event.child_pid)) {
          fail(`dynamic subprocess trace repeats child pid ${event.child_pid}`);
        }
        startByChildPid.set(event.child_pid, event);
      }
    } else {
      if (exitByCallId.has(event.call_id)) {
        fail(`dynamic subprocess trace repeats exit for ${event.call_id}`);
      }
      exitByCallId.set(event.call_id, event);
    }
  }

  for (const [callId] of exitByCallId) {
    if (!startByCallId.has(callId)) {
      fail(`dynamic subprocess trace has an exit without start: ${callId}`);
    }
  }

  for (const boot of bootByPid.values()) {
    if (boot.parent_call_id === null) continue;
    const start = startByCallId.get(boot.parent_call_id);
    if (!start || !start.started) {
      fail(
        `dynamic subprocess boot pid ${boot.pid} has no started parent call ` +
        boot.parent_call_id
      );
    }
    const pidStart = startByChildPid.get(boot.pid);
    if (pidStart && pidStart.call_id !== boot.parent_call_id) {
      fail(`dynamic subprocess boot pid ${boot.pid} changed its parent call`);
    }
  }

  const cliBoots = [...bootByPid.values()].filter((boot) => boot.role === "cli");
  const originatingStartByCliPid = new Map(cliBoots.map((boot) => [
    boot.pid,
    originatingStart(boot.pid, bootByPid, startByChildPid, startByCallId)
  ]));
  const outerCli = cliBoots.filter((boot) =>
    !hasCliAncestor(boot.pid, bootByPid, startByChildPid, startByCallId)
  ).map((boot) => {
    const start = originatingStartByCliPid.get(boot.pid);
    return { boot, start, outcome: outcomeFor(start, exitByCallId) };
  });
  const nestedCliStarts = cliBoots.length - outerCli.length;
  const targetedCliStarts = starts.filter((start) =>
    start.started && start.target_role === "cli"
  );
  const targetWithoutBoot = targetedCliStarts.filter((start) =>
    !cliBoots.some((boot) =>
      originatingStartByCliPid.get(boot.pid)?.call_id === start.call_id
    )
  );
  const unattributedCliStarts = outerCli.filter(({ boot }) => !boot.origin_test);

  const byAction = {};
  const byTest = {};
  const commandStarts = {};
  for (const { boot } of outerCli) {
    increment(byAction, boot.action ?? "<none>");
    increment(byTest, boot.origin_test ?? "<unattributed>");
  }
  for (const start of starts.filter((candidate) => candidate.started)) {
    increment(commandStarts, start.command);
  }

  const outerCliDetails = outerCli.map(({ boot, start, outcome }) => ({
    action: boot.action,
    argumentCount: boot.argument_count,
    childPid: boot.pid,
    end: outcome.end,
    exitCode: outcome.exitCode,
    method: start?.method ?? null,
    optionNames: boot.option_names,
    originTest: boot.origin_test,
    originTestName: boot.origin_test_name,
    signal: outcome.signal,
    start: start?.timestamp_ms ?? boot.timestamp_ms
  }));

  return {
    runId: validated[0]?.run_id ?? runId ?? null,
    eventCount: validated.length,
    processBootCount: bootByPid.size,
    processStartCount: starts.filter((start) => start.started).length,
    outerCliStarts: outerCli.length,
    nestedCliStarts,
    targetedCliStarts: targetedCliStarts.length,
    targetWithoutBoot: targetWithoutBoot.length,
    unattributedCliStarts: unattributedCliStarts.length,
    outerCliByAction: sortedCounts(byAction),
    outerCliByTest: sortedCounts(byTest),
    commandStarts: sortedCounts(commandStarts),
    outerCliDetails,
    processStarts: starts.filter((start) => start.started).map((start) => ({
      command: start.command,
      originTest: start.origin_test,
      originTestName: start.origin_test_name,
      outerCliPid: outerCliAncestorPid(
        start.pid,
        bootByPid,
        startByChildPid,
        startByCallId
      ),
      targetRole: start.target_role
    }))
  };
}

function matchingOuterCli(summary, witnessPath, witnessName) {
  return summary.outerCliDetails.filter((detail) =>
    detail.originTest === witnessPath && detail.originTestName === witnessName
  );
}

function outerCliMatchesRequirement(detail, requirement) {
  if (requirement.kind === "outer_cli_argv") {
    return detail.action === requirement.action &&
      requirement.required_options.every((option) =>
        detail.optionNames.includes(option)
      );
  }
  if (requirement.kind === "outer_cli_nonzero_exit") {
    return detail.signal !== null ||
      (detail.exitCode !== null && detail.exitCode !== 0);
  }
  if (requirement.kind === "outer_cli_exit_code") {
    return detail.exitCode === requirement.code;
  }
  if (requirement.kind === "outer_cli_signal") {
    return detail.signal === requirement.signal;
  }
  if (requirement.kind === "outer_cli_live_pid") {
    return ASYNC_METHODS.has(detail.method) && detail.childPid > 0;
  }
  return false;
}

function evaluateRequirement(
  requirement,
  witnessPath,
  witnessName,
  summary,
  groupedOuterCli,
  groupedCommandStarts
) {
  const outerCli = groupedOuterCli ?? matchingOuterCli(
    summary,
    witnessPath,
    witnessName
  );
  if (requirement.kind.startsWith("outer_cli_") &&
      requirement.kind !== "outer_cli_overlap") {
    const observed = outerCli.length;
    return { met: observed >= requirement.minimum, observed };
  }
  if (requirement.kind === "outer_cli_overlap") {
    const intervals = outerCli
      .filter((detail) => detail.end !== null && detail.end >= detail.start)
      .map((detail) => ({ start: detail.start, end: detail.end }));
    const observed = maximumOverlap(intervals);
    return { met: observed >= requirement.minimum_concurrent, observed };
  }
  const observed = (groupedCommandStarts ?? summary.processStarts).filter(
    (start) => start.originTest === witnessPath &&
      start.originTestName === witnessName &&
      start.command === requirement.command
  ).length;
  return { met: observed >= requirement.minimum, observed };
}

export function validateRetainedDynamicBoundaries(config, summary) {
  const commandGroupForBoundary = (boundary) => {
    const sharedBoundaries = config.retained_boundaries.filter((candidate) =>
      candidate.path === boundary.path && candidate.needle === boundary.needle
    );
    const sharedRequirements = sharedBoundaries.flatMap((candidate) =>
      candidate.requirements.filter((requirement) =>
        requirement.kind === "command_start"
      )
    );
    if (sharedRequirements.length === 0) return undefined;
    const byOuterCli = new Map();
    for (const start of summary.processStarts.filter((candidate) =>
      candidate.originTest === boundary.path &&
      candidate.originTestName === boundary.needle &&
      Number.isSafeInteger(candidate.outerCliPid)
    )) {
      const group = byOuterCli.get(start.outerCliPid) ?? [];
      group.push(start);
      byOuterCli.set(start.outerCliPid, group);
    }
    return [...byOuterCli.values()].find((group) =>
      sharedRequirements.every((requirement) =>
        group.filter((start) => start.command === requirement.command)
          .length >= requirement.minimum
      )
    ) ?? [];
  };

  return config.retained_boundaries.map((boundary) => {
    const detailRequirements = boundary.requirements.filter((requirement) =>
      [
        "outer_cli_argv",
        "outer_cli_nonzero_exit",
        "outer_cli_exit_code",
        "outer_cli_signal",
        "outer_cli_live_pid"
      ].includes(requirement.kind)
    );
    const groupedOuterCli = detailRequirements.length === 0
      ? undefined
      : matchingOuterCli(summary, boundary.path, boundary.needle).filter((detail) =>
          detailRequirements.every((requirement) =>
            outerCliMatchesRequirement(detail, requirement)
          )
        );
    const groupedCommandStarts = commandGroupForBoundary(boundary);
    const requirements = boundary.requirements.map((requirement) => ({
      ...requirement,
      ...evaluateRequirement(
        requirement,
        boundary.path,
        boundary.needle,
        summary,
        groupedOuterCli,
        groupedCommandStarts
      )
    }));
    return {
      id: boundary.id,
      met: requirements.every((requirement) => requirement.met),
      requirements
    };
  });
}

export function compareDynamicSubprocessEvidence({
  baselineSummary,
  config,
  currentSummary
}) {
  for (const [label, summary] of [
    ["baseline", baselineSummary],
    ["current", currentSummary]
  ]) {
    if (summary.targetWithoutBoot !== 0) {
      fail(`${label} trace lost ${summary.targetWithoutBoot} targeted CLI boot(s)`);
    }
    if (summary.unattributedCliStarts !== 0) {
      fail(`${label} trace has ${summary.unattributedCliStarts} unattributed CLI start(s)`);
    }
  }
  if (!Number.isSafeInteger(baselineSummary.outerCliStarts) ||
      baselineSummary.outerCliStarts < 1) {
    fail("dynamic subprocess baseline observed no outer CLI starts");
  }
  const currentPercentBasisPoints = Math.round(
    (currentSummary.outerCliStarts * 10_000) / baselineSummary.outerCliStarts
  );
  const targetMaximumBasisPoints =
    config.final_threshold.maximum_percent_of_baseline * 100;
  if (currentPercentBasisPoints > targetMaximumBasisPoints) {
    fail(
      `dynamic subprocess target requires current <= ` +
      `${config.final_threshold.maximum_percent_of_baseline}% of baseline; ` +
      `observed ${(currentPercentBasisPoints / 100).toFixed(2)}%`
    );
  }
  const retainedBoundaries = validateRetainedDynamicBoundaries(
    config,
    currentSummary
  );
  const missingBoundaries = retainedBoundaries.filter((boundary) => !boundary.met);
  if (missingBoundaries.length > 0) {
    fail(
      `dynamic subprocess retained boundaries are missing: ` +
      missingBoundaries.map((boundary) => boundary.id).join(", ")
    );
  }
  return {
    baselineOuterCliStarts: baselineSummary.outerCliStarts,
    currentOuterCliStarts: currentSummary.outerCliStarts,
    currentPercentBasisPoints,
    reductionBasisPoints: Math.round(
      ((baselineSummary.outerCliStarts - currentSummary.outerCliStarts) * 10_000) /
      baselineSummary.outerCliStarts
    ),
    retainedBoundaries
  };
}

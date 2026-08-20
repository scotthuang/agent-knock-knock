"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const moduleBuiltin = require("node:module");
const path = require("node:path");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");

const TRACE_DIRECTORY_ENV = "AKK_SUBPROCESS_EVIDENCE_DIR";
const REPOSITORY_ROOT_ENV = "AKK_SUBPROCESS_EVIDENCE_ROOT";
const RUN_ID_ENV = "AKK_SUBPROCESS_EVIDENCE_RUN_ID";
const PRELOAD_ENV = "AKK_SUBPROCESS_EVIDENCE_PRELOAD";
const ORIGIN_TEST_ENV = "AKK_SUBPROCESS_EVIDENCE_ORIGIN_TEST";
const ORIGIN_TEST_NAME_ENV = "AKK_SUBPROCESS_EVIDENCE_TEST_NAME";
const PARENT_CALL_ID_ENV = "AKK_SUBPROCESS_EVIDENCE_PARENT_CALL_ID";
const TEST_FILE_SHARD_CONFIG_PATH = path.join(
  __dirname,
  "..",
  "config",
  "test-file-shards.json"
);
const PATCHED = Symbol.for("agent-knock-knock.dynamic-subprocess-evidence");
const TRACE_SCHEMA = "agent-knock-knock/subprocess-trace";
const TRACE_VERSION = 1;
const ASYNC_METHODS = new Set(["exec", "execFile", "fork", "spawn"]);
const SYNC_METHODS = new Set(["execFileSync", "execSync", "spawnSync"]);
const METHODS = [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync"
];
const EVIDENCE_TEST_NAMES = new Set([
  "doctor exits non-zero when required package files are missing",
  "raw background send durably prepares its terminal submission before tmux accepts it",
  // The current preload measures both revisions, so the immutable baseline's
  // three now-consolidated crash witnesses must remain valid trace origins.
  "zero-input deferred source Session reservation before its transfer receipt recovery aborts safely before one refreshed retry",
  "zero-input deferred source reservation recovery aborts safely before one refreshed retry",
  "zero-input deferred target preparation recovery aborts safely before one refreshed retry",
  "zero-input deferred prepared ledger before Turn state recovery aborts safely before one refreshed retry",
  "concurrent callback retries claim one attempt and report the winner in flight",
  "managed terminal send cannot overwrite a concurrent terminal cancellation",
  "terminal bridge monitor singleton rejects a live owner and reclaims a dead owner",
  "dynamic shell descendant evidence probe"
]);
const testFileShardConfig = JSON.parse(
  fs.readFileSync(TEST_FILE_SHARD_CONFIG_PATH, "utf8")
);
if (
  testFileShardConfig.schema !== "agent-knock-knock/test-file-shards" ||
  testFileShardConfig.version !== 1 ||
  !Array.isArray(testFileShardConfig.expansions)
) {
  throw new Error("dynamic subprocess evidence test shard config is malformed");
}
const canonicalTestByCompiledShard = new Map();
for (const expansion of testFileShardConfig.expansions) {
  if (
    !expansion ||
    typeof expansion.canonical_source !== "string" ||
    !Array.isArray(expansion.compiled_shards)
  ) {
    throw new Error("dynamic subprocess evidence test shard expansion is malformed");
  }
  for (const compiledShard of expansion.compiled_shards) {
    if (
      typeof compiledShard !== "string" ||
      canonicalTestByCompiledShard.has(compiledShard)
    ) {
      throw new Error("dynamic subprocess evidence test shard path is invalid");
    }
    canonicalTestByCompiledShard.set(
      compiledShard,
      expansion.canonical_source
    );
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function evidenceCallId(value) {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{8}$/u.test(value)) {
    throw new Error("dynamic subprocess evidence parent call id is malformed");
  }
  return value;
}

function evidenceTestName(value) {
  if (value === undefined) return null;
  if (!EVIDENCE_TEST_NAMES.has(value)) {
    throw new Error("dynamic subprocess evidence test name is not allowlisted");
  }
  return value;
}

const traceDirectory = nonEmpty(process.env[TRACE_DIRECTORY_ENV]);
const repositoryRoot = nonEmpty(process.env[REPOSITORY_ROOT_ENV]);
const runId = nonEmpty(process.env[RUN_ID_ENV]);
const preloadPath = nonEmpty(process.env[PRELOAD_ENV]);

if (!traceDirectory || !path.isAbsolute(traceDirectory) ||
    !repositoryRoot || !path.isAbsolute(repositoryRoot) ||
    !runId || !preloadPath || !path.isAbsolute(preloadPath)) {
  throw new Error(
    "dynamic subprocess evidence preload requires absolute trace, root, and preload paths plus a run id"
  );
}
if (/\s/u.test(preloadPath)) {
  throw new Error("dynamic subprocess evidence preload path must not contain whitespace");
}

fs.mkdirSync(traceDirectory, { recursive: true });
const tracePath = path.join(traceDirectory, `trace-${process.pid}.ndjson`);
let sequence = 0;
const invocationStack = [];

function normalizedPath(value) {
  return String(value).split(path.sep).join("/");
}

function repositoryEntry(value) {
  if (typeof value !== "string" || value.length === 0 || value === "-e") {
    return null;
  }
  let absolutePath;
  try {
    absolutePath = path.isAbsolute(value)
      ? path.normalize(value)
      : path.resolve(process.cwd(), value);
  } catch {
    return `external:${path.basename(value) || "unknown"}`;
  }
  const relative = path.relative(repositoryRoot, absolutePath);
  if (relative !== "" && relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return normalizedPath(relative);
  }
  return `external:${path.basename(absolutePath) || "unknown"}`;
}

function isCliPath(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizedPath(value);
  return normalized.endsWith("/dist/src/cli.js") ||
    normalized.endsWith("/src/cli.js") ||
    normalized === "dist/src/cli.js" ||
    normalized === "src/cli.js";
}

function testPathFromEntry(value) {
  const entry = repositoryEntry(value);
  const canonicalShardSource = canonicalTestByCompiledShard.get(entry);
  if (canonicalShardSource) {
    return canonicalShardSource;
  }
  const match = /^dist\/(test\/.+\.test)\.js$/u.exec(entry ?? "");
  return match ? `${match[1]}.ts` : null;
}

function roleForEntry(value) {
  if (isCliPath(value)) {
    return "cli";
  }
  if (testPathFromEntry(value)) {
    return "test";
  }
  if (typeof value === "string" && value.length > 0) {
    return "node";
  }
  return "other";
}

function safeAction(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return /^(?:--?[a-z][a-z0-9-]*|[a-z][a-z0-9-]*)$/u.test(value)
    ? value
    : "<non-command>";
}

function optionNames(values) {
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "string" || !value.startsWith("-")) {
      return [];
    }
    const name = value.split("=", 1)[0];
    return /^--?[a-zA-Z][a-zA-Z0-9-]*$/u.test(name) ? [name] : [];
  }))].sort();
}

function baseEvent(event) {
  return {
    schema: TRACE_SCHEMA,
    version: TRACE_VERSION,
    run_id: runId,
    event,
    pid: process.pid,
    ppid: process.ppid,
    timestamp_ms: Date.now(),
    origin_test: currentOriginTest,
    origin_test_name: currentOriginTestName
  };
}

function writeEvent(event) {
  fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

const processEntry = process.argv[1];
const derivedOriginTest = testPathFromEntry(processEntry);
const inheritedOriginTest = nonEmpty(process.env[ORIGIN_TEST_ENV]);
const currentOriginTest = derivedOriginTest ?? inheritedOriginTest ?? null;
const currentOriginTestName = evidenceTestName(
  nonEmpty(process.env[ORIGIN_TEST_NAME_ENV])
);
const parentCallId = evidenceCallId(
  nonEmpty(process.env[PARENT_CALL_ID_ENV])
);
const processRole = roleForEntry(processEntry);
const processArguments = process.argv.slice(2);

writeEvent({
  ...baseEvent("process_boot"),
  entry: repositoryEntry(processEntry),
  role: processRole,
  parent_call_id: parentCallId,
  action: processRole === "cli" ? safeAction(processArguments[0]) : null,
  argument_count: processArguments.length,
  option_names: optionNames(processArguments)
});

function commandBasename(command) {
  if (typeof command !== "string" || command.length === 0) {
    return "<unknown>";
  }
  const basename = path.basename(command);
  return /^[a-zA-Z0-9._+-]+$/u.test(basename) ? basename : "<redacted>";
}

function normalizedInvocation(method, rawArguments) {
  if (method === "fork") {
    const modulePath = rawArguments[0];
    const arguments_ = Array.isArray(rawArguments[1]) ? rawArguments[1] : [];
    return {
      command: process.execPath,
      arguments: [modulePath, ...arguments_].map(String),
      optionsIndex: Array.isArray(rawArguments[1]) ? 2 : 1
    };
  }
  const command = rawArguments[0];
  const arguments_ = Array.isArray(rawArguments[1]) ? rawArguments[1] : [];
  return {
    command: typeof command === "string" ? command : String(command ?? ""),
    arguments: arguments_.map(String),
    optionsIndex: Array.isArray(rawArguments[1]) ? 2 : 1
  };
}

function cliTarget(arguments_, command) {
  if (isCliPath(command)) {
    return { index: -1, action: arguments_[0] };
  }
  const index = arguments_.findIndex((argument) => isCliPath(argument));
  if (index >= 0) {
    return { index, action: arguments_[index + 1] };
  }
  if (typeof command === "string" &&
      /(?:^|[\s'"`])(?:[^\s'"`]*\/)?(?:dist\/)?src\/cli\.js(?:[\s'"`]|$)/u
        .test(normalizedPath(command))) {
    return { index: -1, action: null };
  }
  return null;
}

function isNodeCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  try {
    if (path.resolve(command) === path.resolve(process.execPath)) {
      return true;
    }
  } catch {
    // Fall through to the executable basename.
  }
  return /^node(?:\.exe)?$/iu.test(path.basename(command));
}

function appendPreload(nodeOptions) {
  const evidenceOption = `--require=${preloadPath}`;
  const existing = typeof nodeOptions === "string" ? nodeOptions.trim() : "";
  if (existing.includes(evidenceOption)) {
    return existing;
  }
  return [existing, evidenceOption].filter(Boolean).join(" ");
}

function propagatedArguments(rawArguments, invocation, callId) {
  const copied = [...rawArguments];
  const currentOptions = copied[invocation.optionsIndex];
  if (typeof currentOptions === "function") {
    copied.splice(
      invocation.optionsIndex,
      0,
      propagatedOptions(undefined, callId)
    );
    return copied;
  }
  if (currentOptions !== undefined &&
      (currentOptions === null || typeof currentOptions !== "object" ||
       Array.isArray(currentOptions))) {
    return copied;
  }
  copied[invocation.optionsIndex] = propagatedOptions(currentOptions, callId);
  return copied;
}

function propagatedOptions(currentOptions, callId) {
  const options = currentOptions ? { ...currentOptions } : {};
  const originalEnvironment = options.env && typeof options.env === "object"
    ? options.env
    : process.env;
  const requestedTestName = evidenceTestName(
    nonEmpty(originalEnvironment[ORIGIN_TEST_NAME_ENV])
  );
  options.env = {
    ...originalEnvironment,
    [TRACE_DIRECTORY_ENV]: traceDirectory,
    [REPOSITORY_ROOT_ENV]: repositoryRoot,
    [RUN_ID_ENV]: runId,
    [PRELOAD_ENV]: preloadPath,
    ...(currentOriginTest ? { [ORIGIN_TEST_ENV]: currentOriginTest } : {}),
    ...(currentOriginTestName || requestedTestName
      ? {
          [ORIGIN_TEST_NAME_ENV]: currentOriginTestName ?? requestedTestName
        }
      : {}),
    [PARENT_CALL_ID_ENV]: callId,
    NODE_OPTIONS: appendPreload(originalEnvironment.NODE_OPTIONS)
  };
  return options;
}

function errorCode(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : null;
}

function nullableStatus(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function nullableSignal(value) {
  return typeof value === "string" && /^[A-Z0-9]+$/u.test(value) ? value : null;
}

function startRecord({
  callId,
  childPid,
  detached,
  durationMs,
  error,
  exitCode,
  invocation,
  method,
  signal,
  started,
  startedAt
}) {
  const target = cliTarget(invocation.arguments, invocation.command);
  const nodeTarget = method === "fork" || isNodeCommand(invocation.command);
  const actionArguments = target
    ? target.index < 0
      ? invocation.arguments
      : invocation.arguments.slice(target.index + 1)
    : invocation.arguments;
  return {
    ...baseEvent("process_start"),
    timestamp_ms: startedAt,
    call_id: callId,
    method,
    detached,
    started,
    child_pid: Number.isSafeInteger(childPid) && childPid > 0 ? childPid : null,
    duration_ms: Math.max(0, Math.round(durationMs)),
    target_role: target ? "cli" : nodeTarget ? "node" : "other",
    command: commandBasename(invocation.command),
    action: target ? safeAction(target.action) : null,
    argument_count: invocation.arguments.length,
    option_names: optionNames(actionArguments),
    exit_code: nullableStatus(exitCode),
    signal: nullableSignal(signal),
    error_code: errorCode(error)
  };
}

function attachExitTrace(child, callId) {
  if (!child || typeof child.once !== "function" ||
      !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return;
  }
  child.once("exit", (code, signal) => {
    writeEvent({
      ...baseEvent("process_exit"),
      call_id: callId,
      child_pid: child.pid,
      exit_code: nullableStatus(code),
      signal: nullableSignal(signal)
    });
  });
}

function captureNestedOutcome(context, result, error) {
  const childPid = result?.pid ?? error?.pid;
  if (Number.isSafeInteger(childPid) && childPid > 0) {
    context.childPid = childPid;
  }
  if (result && typeof result === "object") {
    context.exitCode = result.status;
    context.signal = result.signal;
    context.error = result.error;
  } else if (error) {
    context.exitCode = error.status;
    context.signal = error.signal;
    context.error = error;
  }
}

function customPromisified(wrapper) {
  return function dynamicSubprocessEvidencePromise(...arguments_) {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapper(...arguments_, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
    promise.child = child;
    return promise;
  };
}

function patchMethod(method) {
  const original = childProcess[method];
  if (typeof original !== "function") {
    return;
  }
  const wrapper = function dynamicSubprocessEvidenceWrapper(...rawArguments) {
    const parentContext = invocationStack.at(-1);
    if (parentContext) {
      const nestedInvocation = normalizedInvocation(method, rawArguments);
      const propagated = propagatedArguments(
        rawArguments,
        nestedInvocation,
        parentContext.callId
      );
      try {
        const nestedResult = Reflect.apply(original, this, propagated);
        captureNestedOutcome(parentContext, nestedResult, undefined);
        return nestedResult;
      } catch (error) {
        captureNestedOutcome(parentContext, undefined, error);
        throw error;
      }
    }
    const callId = `${process.pid}:${++sequence}:${crypto.randomBytes(4).toString("hex")}`;
    const invocation = normalizedInvocation(method, rawArguments);
    const propagated = propagatedArguments(rawArguments, invocation, callId);
    const startedAt = Date.now();
    const context = {
      callId,
      childPid: null,
      error: null,
      exitCode: null,
      signal: null
    };
    invocationStack.push(context);
    try {
      const result = Reflect.apply(original, this, propagated);
      captureNestedOutcome(context, result, undefined);
      const durationMs = Date.now() - startedAt;
      const invocationOptions = propagated[invocation.optionsIndex];
      const detached = Boolean(
        invocationOptions && typeof invocationOptions === "object" &&
        !Array.isArray(invocationOptions) && invocationOptions.detached === true
      );
      if (ASYNC_METHODS.has(method)) {
        const childPid = result?.pid ?? context.childPid;
        const started = Number.isSafeInteger(childPid) && childPid > 0;
        writeEvent(startRecord({
          callId,
          childPid,
          detached,
          durationMs,
          error: null,
          exitCode: null,
          invocation,
          method,
          signal: null,
          started,
          startedAt
        }));
        if (started) {
          attachExitTrace(result, callId);
        }
      } else if (method === "spawnSync") {
        const childPid = result?.pid ?? context.childPid;
        const started = Number.isSafeInteger(childPid) && childPid > 0 &&
          !result.error;
        writeEvent(startRecord({
          callId,
          childPid,
          detached,
          durationMs,
          error: result?.error,
          exitCode: result?.status,
          invocation,
          method,
          signal: result?.signal,
          started,
          startedAt
        }));
      } else if (SYNC_METHODS.has(method)) {
        const started = !context.error;
        writeEvent(startRecord({
          callId,
          childPid: context.childPid,
          detached,
          durationMs,
          error: context.error,
          exitCode: context.exitCode ?? 0,
          invocation,
          method,
          signal: context.signal,
          started,
          startedAt
        }));
      }
      return result;
    } catch (error) {
      captureNestedOutcome(context, undefined, error);
      const childPid = error?.pid ?? context.childPid;
      const invocationOptions = propagated[invocation.optionsIndex];
      const detached = Boolean(
        invocationOptions && typeof invocationOptions === "object" &&
        !Array.isArray(invocationOptions) && invocationOptions.detached === true
      );
      const started = Number.isSafeInteger(childPid) && childPid > 0;
      writeEvent(startRecord({
        callId,
        childPid,
        detached,
        durationMs: Date.now() - startedAt,
        error,
        exitCode: error?.status,
        invocation,
        method,
        signal: error?.signal,
        started,
        startedAt
      }));
      throw error;
    } finally {
      const popped = invocationStack.pop();
      if (popped !== context) {
        throw new Error("dynamic subprocess evidence invocation stack is inconsistent");
      }
    }
  };
  if ((method === "exec" || method === "execFile") && original[promisify.custom]) {
    const descriptor = Object.getOwnPropertyDescriptor(original, promisify.custom);
    Object.defineProperty(wrapper, promisify.custom, {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      value: customPromisified(wrapper),
      writable: descriptor?.writable ?? false
    });
  }
  childProcess[method] = wrapper;
}

if (!childProcess[PATCHED]) {
  Object.defineProperty(childProcess, PATCHED, { value: true });
  for (const method of METHODS) {
    patchMethod(method);
  }
  moduleBuiltin.syncBuiltinESMExports();
}

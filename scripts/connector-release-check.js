#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { synchronizeConnectorSkills } from "./sync-connector-skills.js";

export const CONNECTOR_RELEASE_TARGETS = Object.freeze([
  Object.freeze({
    connector: "deepseek-harness",
    connectorName: "agent-knock-knock-deepseek-harness",
    packagePath: "connectors/deepseek-harness",
    packageName: "@scotthuang/agent-knock-knock-deepseek-harness",
    tagPrefix: "deepseek-harness-v",
  }),
  Object.freeze({
    connector: "pi",
    connectorName: "agent-knock-knock-pi",
    packagePath: "connectors/pi",
    packageName: "@scotthuang/agent-knock-knock-pi",
    tagPrefix: "pi-v",
  }),
]);

const ROOT_PACKAGE_NAME = "@scotthuang/agent-knock-knock";
const LOCKED_MANIFEST_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "engines",
  "optionalDependencies",
  "peerDependencies",
]);
const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Run the complete connector gate. Offline mode performs only deterministic
 * repository checks and local package commands; it never inspects git release
 * state, npm registry state, or publishes.
 */
export function checkConnectorRelease({
  connector,
  repoRoot = defaultRepoRoot,
  offline = false,
  publish = false,
  confirmedVersion = undefined,
  runner = createSystemRunner(),
} = {}) {
  if (offline && publish) {
    throw new Error("offline connector verification cannot publish");
  }
  if (publish && confirmedVersion === undefined) {
    throw new Error("publishing requires --confirm-version <exact package version>");
  }
  if (!publish && confirmedVersion !== undefined) {
    throw new Error("--confirm-version is accepted only together with --publish");
  }

  const target = connectorTarget(connector);
  const root = fs.realpathSync(path.resolve(repoRoot));
  const packageDirectory = path.join(root, target.packagePath);
  const metadata = verifyRepositoryParity({ root, packageDirectory, target });
  if (confirmedVersion !== undefined && confirmedVersion !== metadata.version) {
    throw new Error(
      `confirmed version ${confirmedVersion} does not match package version ${metadata.version}`,
    );
  }

  if (!offline) {
    verifyReleaseWorkspace({ root, metadata, runner });
    verifyUnpublishedRelease({ packageDirectory, metadata, runner });
  }

  runOfflinePackageGates({ packageDirectory, target, runner });

  if (publish) {
    runRequired(
      runner,
      "npm",
      ["publish", "--access", "public", "--tag", metadata.distTag],
      { cwd: packageDirectory, inherit: true },
      `${target.connector} npm publish`,
    );
  }

  return Object.freeze({
    connector: target.connector,
    packageName: metadata.packageName,
    version: metadata.version,
    distTag: metadata.distTag,
    repositoryTag: metadata.repositoryTag,
    skillSha256: metadata.skillSha256,
    mode: offline ? "offline" : publish ? "publish" : "release-check",
    published: publish,
  });
}

/** Execute the fixed offline gate for both connectors without version coupling. */
export function checkAllConnectorsOffline({
  repoRoot = defaultRepoRoot,
  runner = createSystemRunner(),
} = {}) {
  return Object.freeze(CONNECTOR_RELEASE_TARGETS.map((target) =>
    checkConnectorRelease({
      connector: target.connector,
      repoRoot,
      offline: true,
      runner,
    })));
}

/** System command boundary, injectable so policy and ordering are unit-testable. */
export function createSystemRunner() {
  return Object.freeze({
    run(command, arguments_, { cwd, inherit = false } = {}) {
      const result = spawnSync(command, arguments_, {
        cwd,
        encoding: "utf8",
        stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
      });
      return Object.freeze({
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        error: result.error,
      });
    },
  });
}

function connectorTarget(connector) {
  const target = CONNECTOR_RELEASE_TARGETS.find(
    (candidate) => candidate.connector === connector,
  );
  if (!target) throw new Error(`unknown connector ${String(connector)}`);
  return target;
}

function verifyRepositoryParity({ root, packageDirectory, target }) {
  const failures = [];
  const manifest = readJson(
    path.join(packageDirectory, "package.json"),
    `${target.connector} package manifest`,
  );
  const lock = readJson(
    path.join(packageDirectory, "package-lock.json"),
    `${target.connector} package lock`,
  );
  const constants = fs.readFileSync(
    path.join(packageDirectory, "src", "constants.ts"),
    "utf8",
  );
  const constantName = extractStringConstant(constants, "CONNECTOR_NAME");
  const constantPackage = extractStringConstant(constants, "CONNECTOR_PACKAGE");
  const constantVersion = extractStringConstant(constants, "CONNECTOR_VERSION");

  if (manifest.name !== target.packageName) {
    failures.push(`manifest name must be ${target.packageName}`);
  }
  if (constantName !== target.connectorName) {
    failures.push(`CONNECTOR_NAME must be ${target.connectorName}`);
  }
  if (constantPackage !== target.packageName || constantPackage !== manifest.name) {
    failures.push("CONNECTOR_PACKAGE must match the package manifest name");
  }
  if (!supportedSemVer(manifest.version)) {
    failures.push(`package version is not a supported SemVer: ${String(manifest.version)}`);
  }
  if (constantVersion !== manifest.version) {
    failures.push("CONNECTOR_VERSION must match the package manifest version");
  }
  const expectedScripts = {
    "skill:check":
      `node ../../scripts/sync-connector-skills.js --check --connector ${target.connector}`,
    "pack:check":
      "npm run build && npm run skill:check && " +
      `node ../../scripts/verify-connector-skill-pack.js --connector ${target.connector}`,
    "release:check": "node scripts/release-check.mjs",
  };
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (manifest.scripts?.[name] !== expected) {
      failures.push(`package script ${name} must use the canonical connector gate`);
    }
  }

  const lockRoot = lock.packages?.[""];
  if (!lockRoot || typeof lockRoot !== "object") {
    failures.push("package lock is missing its root package record");
  } else {
    if (lock.name !== manifest.name || lockRoot.name !== manifest.name) {
      failures.push("package lock name must match the package manifest");
    }
    if (lock.version !== manifest.version || lockRoot.version !== manifest.version) {
      failures.push("package lock version must match the package manifest");
    }
    for (const section of LOCKED_MANIFEST_SECTIONS) {
      if (!isDeepStrictEqual(lockRoot[section] ?? {}, manifest[section] ?? {})) {
        failures.push(`package lock ${section} must match the package manifest`);
      }
    }
  }

  const coreDependency = manifest.dependencies?.[ROOT_PACKAGE_NAME];
  if (!supportedSemVer(coreDependency)) {
    failures.push(
      `${ROOT_PACKAGE_NAME} dependency must be one exact supported SemVer`,
    );
  }
  const lockedCore = lock.packages?.[`node_modules/${ROOT_PACKAGE_NAME}`]?.version;
  if (lockedCore !== coreDependency) {
    failures.push(
      `package lock must resolve ${ROOT_PACKAGE_NAME}@${String(coreDependency)}`,
    );
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (/^(?:file|link|workspace):/u.test(String(specifier))) {
        failures.push(`${section}.${name} uses non-publishable specifier ${specifier}`);
      }
    }
  }

  let skillSha256;
  try {
    skillSha256 = synchronizeConnectorSkills({
      repoRoot: root,
      check: true,
      connector: target.connector,
    }).canonical.sha256;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (failures.length > 0) throw releaseFailure(failures);
  const distTag = manifest.version.includes("-") ? "next" : "latest";
  return Object.freeze({
    packageName: manifest.name,
    version: manifest.version,
    distTag,
    repositoryTag: `${target.tagPrefix}${manifest.version}`,
    skillSha256,
  });
}

function verifyReleaseWorkspace({ root, metadata, runner }) {
  const failures = [];
  const branch = runGit(runner, root, ["branch", "--show-current"]);
  if (branch !== "main") {
    failures.push(`branch must be main (found ${branch || "detached HEAD"})`);
  }
  if (runGit(runner, root, ["status", "--porcelain"]) !== "") {
    failures.push("git worktree is dirty");
  }
  const upstream = runGitOptional(
    runner,
    root,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
  );
  if (!upstream) {
    failures.push("main has no configured upstream");
  } else {
    const counts = runGitOptional(
      runner,
      root,
      ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
    );
    if (counts !== "0\t0" && counts !== "0 0") {
      failures.push(
        `HEAD is not synchronized with ${upstream} (${counts ?? "unknown divergence"})`,
      );
    }
    const remote = upstream.split("/", 1)[0];
    verifyTagAbsent({ root, metadata, remote, runner, failures });
  }
  if (failures.length > 0) throw releaseFailure(failures);
}

function verifyTagAbsent({ root, metadata, remote, runner, failures }) {
  const reference = `refs/tags/${metadata.repositoryTag}`;
  const local = runCommand(runner, "git", ["show-ref", "--verify", "--quiet", reference], {
    cwd: root,
  });
  if (local.error || ![0, 1].includes(local.status)) {
    failures.push(`could not verify local repository tag ${metadata.repositoryTag}`);
  } else if (local.status === 0) {
    failures.push(`repository tag ${metadata.repositoryTag} already exists locally`);
  }

  const upstream = runCommand(
    runner,
    "git",
    ["ls-remote", "--exit-code", "--tags", remote, reference],
    { cwd: root },
  );
  if (upstream.error || ![0, 2].includes(upstream.status)) {
    failures.push(`could not verify upstream repository tag ${metadata.repositoryTag}`);
  } else if (upstream.status === 0) {
    failures.push(`repository tag ${metadata.repositoryTag} already exists upstream`);
  }
}

function verifyUnpublishedRelease({ packageDirectory, metadata, runner }) {
  const lookup = runCommand(
    runner,
    "npm",
    ["view", `${metadata.packageName}@${metadata.version}`, "version", "--json"],
    { cwd: packageDirectory },
  );
  if (lookup.error) {
    throw releaseFailure([`npm registry version lookup failed: ${lookup.error.message}`]);
  }
  if (lookup.status === 0) {
    throw releaseFailure([
      lookup.stdout.trim()
        ? `${metadata.packageName}@${metadata.version} already exists on npm`
        : "npm registry version lookup returned no version",
    ]);
  }
  if (!/E404|404 Not Found|No match found/u.test(`${lookup.stderr}\n${lookup.stdout}`)) {
    throw releaseFailure([
      "npm registry version lookup failed for a reason other than not-found",
    ]);
  }
}

function runOfflinePackageGates({ packageDirectory, target, runner }) {
  for (const script of ["typecheck", "test:fast", "pack:check"]) {
    runRequired(
      runner,
      "npm",
      ["run", script],
      { cwd: packageDirectory },
      `${target.connector} ${script}`,
    );
  }
}

function runRequired(runner, command, arguments_, options, label) {
  const result = runCommand(runner, command, arguments_, options);
  if (result.error) {
    throw releaseFailure([`${label} failed to start: ${result.error.message}`]);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw releaseFailure([
      `${label} failed${detail ? `: ${detail}` : ` with exit ${String(result.status)}`}`,
    ]);
  }
  return result;
}

function runGit(runner, cwd, arguments_) {
  return runRequired(runner, "git", arguments_, { cwd }, `git ${arguments_[0]}`).stdout.trim();
}

function runGitOptional(runner, cwd, arguments_) {
  const result = runCommand(runner, "git", arguments_, { cwd });
  return result.status === 0 && !result.error ? result.stdout.trim() : undefined;
}

function runCommand(runner, command, arguments_, options) {
  if (!runner || typeof runner.run !== "function") {
    throw new Error("connector release runner must expose run(command, args, options)");
  }
  const result = runner.run(command, Object.freeze([...arguments_]), Object.freeze({ ...options }));
  return Object.freeze({
    status: result?.status ?? null,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : "",
    error: result?.error,
  });
}

function extractStringConstant(source, name) {
  const expression = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*"([^"\\r\\n]+)"\\s*;`,
    "gu",
  );
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw releaseFailure([`${name} must be declared once as a string literal`]);
  }
  return matches[0][1];
}

function supportedSemVer(value) {
  return typeof value === "string" &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(value);
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw releaseFailure([
      `${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw releaseFailure([`${label} must contain one JSON object`]);
  }
  return parsed;
}

function releaseFailure(failures) {
  return new Error(
    "Connector release check failed:\n" +
      failures.map((failure) => `- ${failure}`).join("\n"),
  );
}

function parseInvocation(arguments_, fixedConnector) {
  const remaining = [...arguments_];
  let connector = fixedConnector;
  let all = false;
  let offline = false;
  let publish = false;
  let confirmedVersion;
  while (remaining.length > 0) {
    const argument = remaining.shift();
    if (argument === "--offline") {
      if (offline) throw new Error("--offline may be supplied only once");
      offline = true;
    } else if (argument === "--publish") {
      if (publish) throw new Error("--publish may be supplied only once");
      publish = true;
    } else if (argument === "--confirm-version") {
      if (confirmedVersion !== undefined) {
        throw new Error("--confirm-version may be supplied only once");
      }
      confirmedVersion = remaining.shift();
      if (!confirmedVersion || confirmedVersion.startsWith("--")) {
        throw new Error("--confirm-version requires a value");
      }
    } else if (argument === "--connector" && !fixedConnector) {
      if (connector !== undefined) throw new Error("--connector may be supplied only once");
      connector = remaining.shift();
      if (!connector || connector.startsWith("--")) {
        throw new Error("--connector requires a value");
      }
    } else if (argument === "--all" && !fixedConnector) {
      if (all) throw new Error("--all may be supplied only once");
      all = true;
    } else {
      throw new Error(`unknown release argument: ${String(argument)}`);
    }
  }
  if (all && connector !== undefined) throw new Error("--all and --connector are mutually exclusive");
  if (all && !offline) throw new Error("--all is available only with --offline");
  if (all && (publish || confirmedVersion !== undefined)) {
    throw new Error("--all offline verification cannot publish or confirm a version");
  }
  if (!all && connector === undefined) {
    throw new Error("use --connector <pi|deepseek-harness> or --offline --all");
  }
  return { all, connector, offline, publish, confirmedVersion };
}

export function runConnectorReleaseCheckCli({
  connector: fixedConnector = undefined,
  arguments_ = process.argv.slice(2),
  repoRoot = defaultRepoRoot,
  runner = createSystemRunner(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const invocation = parseInvocation(arguments_, fixedConnector);
    const reports = invocation.all
      ? checkAllConnectorsOffline({ repoRoot, runner })
      : [checkConnectorRelease({
          connector: invocation.connector,
          repoRoot,
          offline: invocation.offline,
          publish: invocation.publish,
          confirmedVersion: invocation.confirmedVersion,
          runner,
        })];
    for (const report of reports) {
      stdout.write(
        `Connector ${report.mode} checks passed for ${report.packageName}@${report.version} ` +
          `(dist-tag ${report.distTag}, repository tag ${report.repositoryTag}, ` +
          `skill sha256 ${report.skillSha256}).\n`,
      );
    }
    if (invocation.offline) {
      stdout.write("Offline mode: release workspace, registry, tags, and publish were not accessed.\n");
    } else if (!invocation.publish) {
      stdout.write("Check-only mode: nothing was published.\n");
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = runConnectorReleaseCheckCli();
}

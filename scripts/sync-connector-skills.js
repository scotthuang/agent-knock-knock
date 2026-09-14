#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_SKILL_PATH =
  "templates/openclaw-skills/agent-knock-knock/SKILL.md";

export const CONNECTOR_SKILL_ARTIFACTS = Object.freeze([
  Object.freeze({
    connector: "deepseek-harness",
    path: "connectors/deepseek-harness/skills/agent-knock-knock/SKILL.md"
  }),
  Object.freeze({
    connector: "pi",
    path: "connectors/pi/skills/agent-knock-knock/SKILL.md"
  })
]);

const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Synchronize generated connector Skill artifacts from the one canonical Skill.
 *
 * The artifact allowlist is fixed above. Callers may select one known connector,
 * but cannot supply source or destination paths.
 */
export function synchronizeConnectorSkills({
  repoRoot = defaultRepoRoot,
  check = false,
  connector = undefined,
  beforeRename = undefined
} = {}) {
  const root = fs.realpathSync(path.resolve(repoRoot));
  const canonicalPath = resolveRepositoryArtifactPath(
    root,
    CANONICAL_SKILL_PATH,
    "canonical Skill"
  );
  const canonicalStat = requiredRegularFile(canonicalPath, "canonical Skill");
  const canonical = fs.readFileSync(canonicalPath);
  const canonicalSha256 = sha256(canonical);
  const selected = selectedArtifacts(connector);
  const results = [];
  const mismatches = [];

  for (const artifact of selected) {
    const artifactPath = resolveRepositoryArtifactPath(
      root,
      artifact.path,
      `${artifact.connector} Skill artifact`,
      { allowMissing: true }
    );
    const existing = readOptionalRegularFile(
      artifactPath,
      `${artifact.connector} Skill artifact`
    );
    if (existing?.equals(canonical)) {
      results.push(Object.freeze({
        connector: artifact.connector,
        path: artifact.path,
        status: "unchanged",
        sha256: canonicalSha256
      }));
      continue;
    }

    const previousStatus = existing ? "drifted" : "missing";
    if (check) {
      mismatches.push(`${artifact.path} is ${previousStatus}`);
      results.push(Object.freeze({
        connector: artifact.connector,
        path: artifact.path,
        status: previousStatus,
        sha256: existing ? sha256(existing) : undefined
      }));
      continue;
    }

    ensureSafeParentDirectory(root, artifact.path);
    writeFileAtomically(
      artifactPath,
      canonical,
      canonicalStat.mode & 0o777,
      {
        beforeRename,
        revalidate: () => resolveRepositoryArtifactPath(
          root,
          artifact.path,
          `${artifact.connector} Skill artifact`,
          { allowMissing: true }
        )
      }
    );
    results.push(Object.freeze({
      connector: artifact.connector,
      path: artifact.path,
      status: previousStatus === "missing" ? "created" : "updated",
      sha256: canonicalSha256
    }));
  }

  if (mismatches.length > 0) {
    throw new Error(
      "connector Skill artifacts do not match the canonical Skill:\n" +
      mismatches.map((entry) => `- ${entry}`).join("\n") +
      "\nRun npm run skill:sync and commit the generated artifacts."
    );
  }

  return Object.freeze({
    mode: check ? "check" : "sync",
    canonical: Object.freeze({
      path: CANONICAL_SKILL_PATH,
      sha256: canonicalSha256
    }),
    artifacts: Object.freeze(results)
  });
}

/** Resolve one repository-relative path while rejecting traversal and symlinks. */
export function resolveRepositoryArtifactPath(
  repoRoot,
  repositoryPath,
  label = "repository artifact",
  { allowMissing = false } = {}
) {
  const root = fs.realpathSync(path.resolve(repoRoot));
  const normalized = normalizedRepositoryPath(repositoryPath, label);
  const segments = normalized.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) {
      if (!allowMissing) {
        throw new Error(`${label} does not exist: ${normalized}`);
      }
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} cannot traverse a symbolic link: ${normalized}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} parent is not a directory: ${normalized}`);
    }
  }
  if (!isInside(root, current)) {
    throw new Error(`${label} must stay inside the repository: ${normalized}`);
  }
  return current;
}

function selectedArtifacts(connector) {
  if (connector === undefined) return CONNECTOR_SKILL_ARTIFACTS;
  if (typeof connector !== "string" || connector.length === 0) {
    throw new Error("connector must be a known non-empty connector id");
  }
  const selected = CONNECTOR_SKILL_ARTIFACTS.filter(
    (artifact) => artifact.connector === connector
  );
  if (selected.length !== 1) {
    throw new Error(`unknown connector ${connector}`);
  }
  return selected;
}

function normalizedRepositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requiredRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return stat;
}

function readOptionalRegularFile(filePath, label) {
  if (!fs.existsSync(filePath)) return undefined;
  requiredRegularFile(filePath, label);
  return fs.readFileSync(filePath);
}

function ensureSafeParentDirectory(root, repositoryPath) {
  const parent = path.posix.dirname(
    normalizedRepositoryPath(repositoryPath, "Skill artifact")
  );
  let current = root;
  for (const segment of parent.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Skill artifact parent must be a real directory: ${repositoryPath}`
      );
    }
  }
}

function writeFileAtomically(
  filePath,
  content,
  mode,
  { beforeRename, revalidate }
) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.` +
      `${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    const flags = fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(temporaryPath, flags, mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (typeof beforeRename === "function") {
      beforeRename(Object.freeze({ temporaryPath, filePath }));
    }
    if (revalidate() !== filePath) {
      throw new Error("Skill artifact path changed before atomic publication");
    }
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseInvocation(arguments_) {
  let check = false;
  let connector;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      if (check) throw new Error("--check may be supplied only once");
      check = true;
      continue;
    }
    if (argument === "--connector") {
      if (connector !== undefined) {
        throw new Error("--connector may be supplied only once");
      }
      connector = arguments_[index + 1];
      if (!connector || connector.startsWith("--")) {
        throw new Error("--connector requires a value");
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return { check, connector };
}

function runCli() {
  try {
    const invocation = parseInvocation(process.argv.slice(2));
    const result = synchronizeConnectorSkills(invocation);
    const artifactSummary = result.artifacts
      .map((artifact) => `${artifact.connector}=${artifact.status}`)
      .join(" ");
    process.stdout.write(
      `Connector Skill ${result.mode} passed: ` +
      `sha256=${result.canonical.sha256} ${artifactSummary}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) runCli();

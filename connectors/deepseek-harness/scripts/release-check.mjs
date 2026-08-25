import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8"));
const arguments_ = process.argv.slice(2);
const publish = takeFlag("--publish");
const confirmedVersion = takeValue("--confirm-version");

if (arguments_.length > 0) {
  fail(`unknown release argument: ${arguments_.join(" ")}`);
}
if (publish && confirmedVersion === undefined) {
  fail("publishing requires --confirm-version <exact package version>");
}
if (!publish && confirmedVersion !== undefined) {
  fail("--confirm-version is accepted only together with --publish");
}
if (confirmedVersion !== undefined && confirmedVersion !== manifest.version) {
  fail(`confirmed version ${confirmedVersion} does not match package version ${manifest.version}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  fail(`package version is not a supported SemVer: ${manifest.version}`);
}

const failures = [];
const branch = git(["branch", "--show-current"]);
if (branch !== "main") failures.push(`branch must be main (found ${branch || "detached HEAD"})`);
if (git(["status", "--porcelain"]) !== "") failures.push("git worktree is dirty");

const upstream = gitOptional(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
if (!upstream) {
  failures.push("main has no configured upstream");
} else {
  const counts = gitOptional(["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  if (counts !== "0\t0" && counts !== "0 0") {
    failures.push(`HEAD is not synchronized with ${upstream} (${counts ?? "unknown divergence"})`);
  }
}

for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
    if (/^(?:file|link|workspace):/u.test(String(specifier))) {
      failures.push(`${section}.${name} uses non-publishable specifier ${specifier}`);
    }
  }
}

const lookup = spawnSync(
  "npm",
  ["view", `${manifest.name}@${manifest.version}`, "version", "--json"],
  { cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (lookup.status === 0 && lookup.stdout.trim() !== "") {
  failures.push(`${manifest.name}@${manifest.version} already exists on npm`);
} else if (lookup.status !== 0 && !/E404|404 Not Found|No match found/u.test(lookup.stderr)) {
  failures.push("npm registry version lookup failed for a reason other than not-found");
}

if (failures.length > 0) {
  process.stderr.write("Connector release check failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

const distTag = manifest.version.includes("-") ? "next" : "latest";
process.stdout.write(
  `Connector release checks passed for ${manifest.name}@${manifest.version} (dist-tag ${distTag}).\n`,
);
if (!publish) {
  process.stdout.write("Check-only mode: nothing was published.\n");
  process.exit(0);
}

const result = spawnSync(
  "npm",
  ["publish", "--access", "public", "--tag", distTag],
  { cwd: packageDirectory, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

function takeFlag(name) {
  const index = arguments_.indexOf(name);
  if (index < 0) return false;
  arguments_.splice(index, 1);
  return true;
}

function takeValue(name) {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  arguments_.splice(index, 2);
  return value;
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) fail(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function gitOptional(args) {
  const result = spawnSync("git", args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

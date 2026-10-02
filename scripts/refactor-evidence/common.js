import fs from "node:fs";
import path from "node:path";

export function fail(message) {
  throw new Error(message);
}

export function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

export function assertExactKeys(value, expectedKeys, label) {
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

export function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

export function assertInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

export function assertBoolean(value, label) {
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

export function assertExactArray(actual, expected, label) {
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

export function assertRepositoryPath(value, label) {
  const repositoryPath = assertString(value, label);
  if (repositoryPath.includes("\\") ||
      repositoryPath.startsWith("/") ||
      repositoryPath.startsWith("./") ||
      repositoryPath.split("/").includes("..")) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return repositoryPath;
}

export function assertPathArray(value, label, { sorted = true } = {}) {
  const paths = assertUniqueStrings(value, label, { sorted });
  for (const [index, repositoryPath] of paths.entries()) {
    assertRepositoryPath(repositoryPath, `${label}[${index}]`);
  }
  return paths;
}

export function readJson(repoRoot, repositoryPath) {
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

export function readRepositoryFile(repoRoot, repositoryPath) {
  const absolutePath = path.join(repoRoot, repositoryPath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`required evidence path is missing: ${repositoryPath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

export function validateAuthorityPaths(paths, label, repoRoot) {
  assertPathArray(paths, label);
  for (const repositoryPath of paths) {
    readRepositoryFile(repoRoot, repositoryPath);
  }
}

export function validateWitnessReferences(ids, label, witnesses, usedWitnesses) {
  assertUniqueStrings(ids, label, { sorted: true });
  for (const id of ids) {
    if (!witnesses.has(id)) {
      fail(`${label} references unknown witness ${id}`);
    }
    usedWitnesses.add(id);
  }
}

export function assertSourcePattern(repoRoot, repositoryPath, pattern, label) {
  if (!pattern.test(readRepositoryFile(repoRoot, repositoryPath))) {
    fail(`${label} is missing from ${repositoryPath}`);
  }
}

export function assertDirectNamedImport(
  repoRoot,
  repositoryPath,
  moduleSpecifier,
  expectedNames,
  label
) {
  const source = readRepositoryFile(repoRoot, repositoryPath);
  const clauses = [...source.matchAll(
    /import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";/gu
  )].filter((match) => match[2] === moduleSpecifier);
  if (clauses.length !== 1) {
    fail(
      `${label} must have one direct named import from ${moduleSpecifier} ` +
      `in ${repositoryPath}`
    );
  }
  const importedNames = clauses[0][1].split(",").map((binding) =>
    binding.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]
  ).filter(Boolean);
  for (const expectedName of expectedNames) {
    if (!importedNames.includes(expectedName)) {
      fail(
        `${label} must directly import ${expectedName} from ` +
        `${moduleSpecifier} in ${repositoryPath}`
      );
    }
  }
}

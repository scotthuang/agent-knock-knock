import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteralLikeNode
} from "typescript/unstable/ast";

export const PRODUCTION_OWNERSHIP_SCHEMA =
  "agent-knock-knock/production-module-ownership";
export const PRODUCTION_OWNERSHIP_VERSION = 1;
export const DYNAMIC_IMPORT_POLICY = "literal-only-fail-closed";
export const MANDATORY_FULL_PRODUCTION_PATHS = Object.freeze([
  "src/cli-core.ts",
  "src/protocol.ts",
  "src/store.ts"
]);

const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedRepositoryPath(repositoryPath) {
  return String(repositoryPath).split(path.sep).join("/");
}

function walkTypeScriptFiles(directory, repoRoot) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return walkTypeScriptFiles(absolutePath, repoRoot);
      }
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [normalizedRepositoryPath(path.relative(repoRoot, absolutePath))]
        : [];
    });
}

export function discoverProductionModulePaths(repoRoot = defaultRepoRoot) {
  const sourceRoot = path.join(repoRoot, "src");
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`production source directory is missing: ${sourceRoot}`);
  }
  return walkTypeScriptFiles(sourceRoot, repoRoot).sort();
}

export function readProductionModuleOwnershipManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read production ownership manifest ${manifestPath}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function recordUnexpectedKeys(record, allowedKeys, label, errors) {
  const unexpected = Object.keys(record)
    .filter((key) => !allowedKeys.includes(key))
    .sort();
  if (unexpected.length > 0) {
    errors.push(`${label} contains unexpected keys: ${unexpected.join(", ")}`);
  }
}

function recordSorted(values, label, errors) {
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    errors.push(`${label} must be sorted for deterministic review`);
  }
}

export function validateProductionModuleOwnershipManifest({
  manifest,
  productionPaths,
  integrationTests
}) {
  const errors = [];
  const discoveredPaths = Array.isArray(productionPaths)
    ? [...new Set(productionPaths.map(normalizedRepositoryPath))].sort()
    : [];
  const integrationSet = new Set(
    Array.isArray(integrationTests) ? integrationTests : []
  );

  if (!isRecord(manifest)) {
    throw new Error("production ownership manifest must be a JSON object");
  }
  recordUnexpectedKeys(
    manifest,
    ["schema", "version", "architecture", "domains", "modules"],
    "production ownership manifest",
    errors
  );
  if (manifest.schema !== PRODUCTION_OWNERSHIP_SCHEMA) {
    errors.push(
      `manifest schema must be ${JSON.stringify(PRODUCTION_OWNERSHIP_SCHEMA)}`
    );
  }
  if (manifest.version !== PRODUCTION_OWNERSHIP_VERSION) {
    errors.push(`manifest version must be ${PRODUCTION_OWNERSHIP_VERSION}`);
  }

  let architecture;
  if (!isRecord(manifest.architecture)) {
    errors.push("manifest architecture must be an object");
  } else {
    recordUnexpectedKeys(
      manifest.architecture,
      [
        "cli_core_max_physical_loc",
        "production_physical_loc",
        "cli_core_importers"
      ],
      "manifest architecture",
      errors
    );
    const cliCoreMaxPhysicalLoc =
      manifest.architecture.cli_core_max_physical_loc;
    if (
      !Number.isSafeInteger(cliCoreMaxPhysicalLoc) ||
      cliCoreMaxPhysicalLoc < 1
    ) {
      errors.push("architecture cli_core_max_physical_loc must be a positive integer");
    }
    const productionPhysicalLoc =
      manifest.architecture.production_physical_loc;
    if (
      !Number.isSafeInteger(productionPhysicalLoc) ||
      productionPhysicalLoc < 1
    ) {
      errors.push("architecture production_physical_loc must be a positive integer");
    }
    const cliCoreImporters = manifest.architecture.cli_core_importers;
    if (!Array.isArray(cliCoreImporters)) {
      errors.push("architecture cli_core_importers must be an array");
    } else {
      const seen = new Set();
      for (const importer of cliCoreImporters) {
        if (
          typeof importer !== "string" ||
          normalizedRepositoryPath(importer) !== importer ||
          !/^src\/.+\.ts$/u.test(importer)
        ) {
          errors.push(`architecture has invalid cli-core importer ${JSON.stringify(importer)}`);
          continue;
        }
        if (seen.has(importer)) {
          errors.push(`architecture repeats cli-core importer ${importer}`);
        }
        seen.add(importer);
      }
      recordSorted(cliCoreImporters, "architecture cli_core_importers", errors);
    }
    const normalizedCliCoreImporters = Array.isArray(cliCoreImporters)
      ? cliCoreImporters
      : [];
    architecture = Object.freeze({
      cliCoreMaxPhysicalLoc,
      productionPhysicalLoc,
      cliCoreImporters: Object.freeze([...normalizedCliCoreImporters])
    });
  }

  const domains = new Map();
  if (!isRecord(manifest.domains) || Object.keys(manifest.domains).length === 0) {
    errors.push("manifest domains must be a non-empty object");
  } else {
    const domainNames = Object.keys(manifest.domains);
    recordSorted(domainNames, "manifest domain names", errors);
    for (const domainName of domainNames) {
      const definition = manifest.domains[domainName];
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(domainName)) {
        errors.push(`invalid production domain name: ${JSON.stringify(domainName)}`);
      }
      if (!isRecord(definition)) {
        errors.push(`domain ${JSON.stringify(domainName)} must be an object`);
        continue;
      }
      recordUnexpectedKeys(
        definition,
        ["selection", "integration_tests"],
        `domain ${JSON.stringify(domainName)}`,
        errors
      );
      if (definition.selection !== "full" && definition.selection !== "targeted") {
        errors.push(
          `domain ${JSON.stringify(domainName)} selection must be full or targeted`
        );
        continue;
      }

      let selectedTests = [];
      if (definition.selection === "full") {
        if (Object.hasOwn(definition, "integration_tests")) {
          errors.push(
            `full domain ${JSON.stringify(domainName)} must not declare integration_tests`
          );
        }
      } else if (
        !Array.isArray(definition.integration_tests) ||
        definition.integration_tests.length === 0
      ) {
        errors.push(
          `targeted domain ${JSON.stringify(domainName)} must declare integration_tests`
        );
      } else {
        selectedTests = definition.integration_tests;
        const seenTests = new Set();
        for (const testPath of selectedTests) {
          if (typeof testPath !== "string" || !testPath.startsWith("test/")) {
            errors.push(
              `domain ${JSON.stringify(domainName)} has invalid integration test ` +
              `${JSON.stringify(testPath)}`
            );
            continue;
          }
          if (seenTests.has(testPath)) {
            errors.push(
              `domain ${JSON.stringify(domainName)} repeats integration test ${testPath}`
            );
          }
          seenTests.add(testPath);
          if (!integrationSet.has(testPath)) {
            errors.push(
              `domain ${JSON.stringify(domainName)} integration test ${testPath} ` +
              "is not in the integration tier"
            );
          }
        }
      }
      domains.set(domainName, Object.freeze({
        selection: definition.selection,
        integrationTests: Object.freeze([...selectedTests])
      }));
    }
  }

  const moduleOwners = new Map();
  const usedDomains = new Set();
  if (!Array.isArray(manifest.modules)) {
    errors.push("manifest modules must be an array");
  } else {
    const declaredPaths = [];
    for (const [index, moduleEntry] of manifest.modules.entries()) {
      const label = `manifest module at index ${index}`;
      if (!isRecord(moduleEntry)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      recordUnexpectedKeys(moduleEntry, ["path", "owner"], label, errors);
      const modulePath = moduleEntry.path;
      const owner = moduleEntry.owner;
      if (
        typeof modulePath !== "string" ||
        normalizedRepositoryPath(modulePath) !== modulePath ||
        !/^src\/.+\.ts$/u.test(modulePath)
      ) {
        errors.push(`${label} has invalid path ${JSON.stringify(modulePath)}`);
        continue;
      }
      declaredPaths.push(modulePath);
      if (moduleOwners.has(modulePath)) {
        errors.push(`production module is declared more than once: ${modulePath}`);
        continue;
      }
      if (typeof owner !== "string" || !domains.has(owner)) {
        errors.push(
          `production module ${modulePath} has unknown owner ${JSON.stringify(owner)}`
        );
        continue;
      }
      usedDomains.add(owner);
      const domain = domains.get(owner);
      moduleOwners.set(modulePath, Object.freeze({
        owner,
        selection: domain.selection,
        integrationTests: domain.integrationTests
      }));
    }
    recordSorted(declaredPaths, "manifest module paths", errors);
  }

  const declaredPathSet = new Set(moduleOwners.keys());
  const missingPaths = discoveredPaths.filter((modulePath) =>
    !declaredPathSet.has(modulePath)
  );
  const extraPaths = [...declaredPathSet].filter((modulePath) =>
    !discoveredPaths.includes(modulePath)
  ).sort();
  if (missingPaths.length > 0) {
    errors.push(`production modules without owners: ${missingPaths.join(", ")}`);
  }
  if (extraPaths.length > 0) {
    errors.push(`ownership entries missing from disk: ${extraPaths.join(", ")}`);
  }

  if (architecture) {
    for (const importer of architecture.cliCoreImporters) {
      if (!moduleOwners.has(importer)) {
        errors.push(`cli-core importer is not an owned production module: ${importer}`);
      }
    }
  }

  for (const domainName of domains.keys()) {
    if (!usedDomains.has(domainName)) {
      errors.push(`production domain has no modules: ${domainName}`);
    }
  }
  for (const mandatoryPath of MANDATORY_FULL_PRODUCTION_PATHS) {
    const impact = moduleOwners.get(mandatoryPath);
    if (!discoveredPaths.includes(mandatoryPath)) {
      errors.push(`required production module is missing from disk: ${mandatoryPath}`);
    }
    if (!impact || impact.selection !== "full") {
      errors.push(`mandatory shared core module must select full: ${mandatoryPath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`production ownership manifest is invalid: ${errors.join("; ")}`);
  }

  return Object.freeze({
    schema: manifest.schema,
    version: manifest.version,
    architecture,
    domains: Object.freeze(Object.fromEntries(domains)),
    modules: Object.freeze(Object.fromEntries(moduleOwners))
  });
}

export function loadAndValidateProductionModuleOwnership({
  repoRoot = defaultRepoRoot,
  manifestPath,
  tiers,
  manifest,
  productionPaths
} = {}) {
  const resolvedManifestPath = manifestPath ?? path.join(
    repoRoot,
    "config",
    "production-module-ownership.json"
  );
  const loadedManifest = manifest ??
    readProductionModuleOwnershipManifest(resolvedManifestPath);
  return validateProductionModuleOwnershipManifest({
    manifest: loadedManifest,
    productionPaths: productionPaths ?? discoverProductionModulePaths(repoRoot),
    integrationTests: tiers?.integration
  });
}

export function physicalLineCount(source) {
  if (source.length === 0) {
    return 0;
  }
  const lines = source.split(/\r?\n/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function literalModuleSpecifier(expression) {
  return expression && isStringLiteralLikeNode(expression)
    ? expression.text
    : undefined;
}

function relativeImportSpecifiers(sourceFile, modulePath) {
  const specifiers = [];
  const errors = [];
  const recordSpecifier = (specifier) => {
    if (specifier?.startsWith(".")) {
      specifiers.push(specifier);
    }
  };

  // Static ESM/CommonJS declarations are read only from the compiler's
  // top-level statement AST. This deliberately avoids source-text scanning.
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement) || isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier) {
        continue;
      }
      const specifier = literalModuleSpecifier(statement.moduleSpecifier);
      if (specifier === undefined) {
        errors.push(`static module specifier is not a literal in ${modulePath}`);
      } else {
        recordSpecifier(specifier);
      }
      continue;
    }
    if (!isImportEqualsDeclaration(statement)) {
      continue;
    }
    if (!isExternalModuleReference(statement.moduleReference)) {
      continue;
    }
    const specifier = literalModuleSpecifier(statement.moduleReference.expression);
    if (specifier === undefined) {
      errors.push(`import-equals module specifier is not a literal in ${modulePath}`);
    } else {
      recordSpecifier(specifier);
    }
  }

  // Dynamic imports are edges only when their sole argument is a literal.
  // Computed forms fail closed because their production dependency cannot be
  // proven from the AST. This policy is intentionally stricter than ignoring
  // an unknown runtime edge.
  const visitDynamicImports = (node) => {
    if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments.length === 1
        ? literalModuleSpecifier(node.arguments[0])
        : undefined;
      if (specifier === undefined) {
        errors.push(
          `dynamic import must use one literal specifier in ${modulePath} ` +
          `(policy: ${DYNAMIC_IMPORT_POLICY})`
        );
      } else {
        recordSpecifier(specifier);
      }
    }
    node.forEachChild(visitDynamicImports);
  };
  sourceFile.forEachChild(visitDynamicImports);

  return { specifiers, errors };
}

function withTypeScriptSourceFiles({ repoRoot, sources }, inspect) {
  const configPath = path.join(repoRoot, "tsconfig.json");
  const api = new TypeScriptApi({
    cwd: repoRoot,
    fs: {
      readFile(fileName) {
        const repositoryPath = normalizedRepositoryPath(
          path.relative(repoRoot, fileName)
        );
        return sources.has(repositoryPath)
          ? sources.get(repositoryPath)
          : undefined;
      }
    }
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    if (!project) {
      throw new Error(`TypeScript project could not be loaded: ${configPath}`);
    }
    const sourceFiles = new Map();
    for (const modulePath of sources.keys()) {
      const sourceFile = project.program.getSourceFile(path.join(repoRoot, modulePath));
      if (!sourceFile) {
        throw new Error(`TypeScript AST is missing production module ${modulePath}`);
      }
      sourceFiles.set(modulePath, sourceFile);
    }
    return inspect(sourceFiles);
  } finally {
    api.close();
  }
}

function resolveProductionImport(importerPath, specifier, productionPaths) {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier)
  );
  const candidates = [];
  if (/\.(?:[cm]?js|ts)$/u.test(unresolved)) {
    candidates.push(unresolved.replace(/\.(?:[cm]?js|ts)$/u, ".ts"));
  } else {
    candidates.push(`${unresolved}.ts`, `${unresolved}/index.ts`);
  }
  return candidates.find((candidate) => productionPaths.has(candidate));
}

function canonicalCycle(cycle) {
  const withoutRepeatedEnd = cycle.at(0) === cycle.at(-1)
    ? cycle.slice(0, -1)
    : [...cycle];
  const rotations = withoutRepeatedEnd.map((_, index) => [
    ...withoutRepeatedEnd.slice(index),
    ...withoutRepeatedEnd.slice(0, index)
  ]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return rotations[0];
}

function importCycles(graph) {
  const state = new Map();
  const stack = [];
  const found = new Map();

  function visit(modulePath) {
    state.set(modulePath, "visiting");
    stack.push(modulePath);
    for (const dependency of graph.get(modulePath) ?? []) {
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        const start = stack.indexOf(dependency);
        const canonical = canonicalCycle([...stack.slice(start), dependency]);
        found.set(canonical.join("\0"), canonical);
      } else if (dependencyState !== "visited") {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(modulePath, "visited");
  }

  for (const modulePath of [...graph.keys()].sort()) {
    if (!state.has(modulePath)) {
      visit(modulePath);
    }
  }
  return [...found.values()].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0"))
  );
}

export function validateProductionArchitecture({
  ownership,
  repoRoot = defaultRepoRoot,
  readSource = (modulePath) => fs.readFileSync(path.join(repoRoot, modulePath), "utf8")
}) {
  if (!ownership?.architecture || !ownership?.modules) {
    throw new Error("validated production ownership is required for architecture checks");
  }
  const errors = [];
  const productionPaths = new Set(Object.keys(ownership.modules));
  const sources = new Map();
  const graph = new Map();
  for (const modulePath of [...productionPaths].sort()) {
    let source;
    try {
      source = readSource(modulePath);
    } catch (error) {
      errors.push(
        `cannot read production module ${modulePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    sources.set(modulePath, source);
  }

  if (sources.size === productionPaths.size) {
    try {
      withTypeScriptSourceFiles({ repoRoot, sources }, (sourceFiles) => {
        for (const modulePath of [...productionPaths].sort()) {
          const dependencies = new Set();
          const parsed = relativeImportSpecifiers(
            sourceFiles.get(modulePath),
            modulePath
          );
          errors.push(...parsed.errors);
          for (const specifier of parsed.specifiers) {
            const dependency = resolveProductionImport(
              modulePath,
              specifier,
              productionPaths
            );
            if (!dependency) {
              errors.push(
                `production import cannot be resolved: ${modulePath} -> ${specifier}`
              );
              continue;
            }
            dependencies.add(dependency);
          }
          graph.set(modulePath, [...dependencies].sort());
        }
      });
    } catch (error) {
      errors.push(
        `cannot inspect production imports with TypeScript compiler API: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const cliCorePath = "src/cli-core.ts";
  const cliCoreSource = sources.get(cliCorePath);
  const cliCorePhysicalLoc = cliCoreSource === undefined
    ? undefined
    : physicalLineCount(cliCoreSource);
  const productionPhysicalLoc = [...sources.values()].reduce(
    (total, source) => total + physicalLineCount(source),
    0
  );
  if (cliCoreSource === undefined) {
    errors.push(`${cliCorePath} is required for architecture validation`);
  } else if (cliCorePhysicalLoc !== ownership.architecture.cliCoreMaxPhysicalLoc) {
    errors.push(
      `${cliCorePath} physical LOC does not match manifest ratchet ` +
      `${ownership.architecture.cliCoreMaxPhysicalLoc} (actual ${cliCorePhysicalLoc})`
    );
  }
  if (productionPhysicalLoc !== ownership.architecture.productionPhysicalLoc) {
    errors.push(
      `production physical LOC does not match manifest ratchet ` +
      `${ownership.architecture.productionPhysicalLoc} (actual ${productionPhysicalLoc})`
    );
  }

  const actualCliCoreImporters = [...graph]
    .filter(([, dependencies]) => dependencies.includes(cliCorePath))
    .map(([modulePath]) => modulePath)
    .sort();
  const expectedCliCoreImporters = [
    ...ownership.architecture.cliCoreImporters
  ].sort();
  const unapprovedImporters = actualCliCoreImporters.filter((modulePath) =>
    !expectedCliCoreImporters.includes(modulePath)
  );
  const missingImporters = expectedCliCoreImporters.filter((modulePath) =>
    !actualCliCoreImporters.includes(modulePath)
  );
  if (unapprovedImporters.length > 0) {
    errors.push(
      `unapproved cli-core importers: ${unapprovedImporters.join(", ")}`
    );
  }
  if (missingImporters.length > 0) {
    errors.push(
      `declared cli-core importers no longer import cli-core: ` +
      missingImporters.join(", ")
    );
  }

  const cycles = importCycles(graph);
  if (cycles.length > 0) {
    errors.push(
      "production import graph contains cycles: " +
      cycles.map((cycle) => `${cycle.join(" -> ")} -> ${cycle[0]}`).join(", ")
    );
  }

  if (errors.length > 0) {
    throw new Error(`production architecture is invalid: ${errors.join("; ")}`);
  }
  return Object.freeze({
    productionModules: productionPaths.size,
    importEdges: [...graph.values()].reduce(
      (total, dependencies) => total + dependencies.length,
      0
    ),
    importCycles: cycles.length,
    cliCorePhysicalLoc,
    productionPhysicalLoc,
    cliCoreImporters: Object.freeze(actualCliCoreImporters)
  });
}

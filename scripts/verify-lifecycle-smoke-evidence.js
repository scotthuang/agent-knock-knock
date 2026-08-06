#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  LiveLifecycleEvidenceValidationError,
  parseAttestation,
  serializeAttestation,
  validate
} from "../dist/src/live-lifecycle-evidence.js";

const EXIT_VALIDATION = 1;
const EXIT_USAGE = 64;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const USAGE = `Usage:
  node scripts/verify-lifecycle-smoke-evidence.js \\
    (--evidence FILE | --attestation FILE) \\
    [--expected-package-name NAME] [--expected-version VERSION] \\
    [--expected-commit COMMIT] [--require-matrix] \\
    [--max-age-hours HOURS] [--output FILE]
`;

class UsageError extends Error {}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    printUsageError();
    return EXIT_USAGE;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const packageMetadata = readPackageMetadata();
    const expectedPackageName = options.expectedPackageName ?? packageMetadata.name;
    const expectedPackageVersion = options.expectedVersion ?? packageMetadata.version;
    const expectedCommit = options.expectedCommit ?? readRepositoryCommit();
    assertSafeExpectedValue(expectedPackageName, "package name", 256);
    assertSafeExpectedValue(expectedPackageVersion, "version", 128);
    if (!/^[0-9a-f]{40}$/u.test(expectedCommit)) {
      throw new UsageError("invalid expected commit");
    }

    const input = readBoundedText(options.inputPath);
    let unverified;
    if (options.inputKind === "attestation") {
      unverified = parseAttestation(input);
    } else {
      try {
        unverified = JSON.parse(input);
      } catch {
        throw new CliValidationError("invalid_json");
      }
    }

    const evidence = validate(unverified, {
      expectedPackageName,
      expectedPackageVersion,
      expectedCommit,
      requireAgents: options.requireMatrix ? ["codex", "claude"] : [],
      maxAgeHours: options.maxAgeHours
    });

    if (options.outputPath !== undefined) {
      const tagMessage = [
        `Release v${evidence.package.version}`,
        "",
        serializeAttestation(evidence),
        ""
      ].join("\n");
      writePrivateRegularFile(options.outputPath, tagMessage);
      process.stdout.write(
        `Live lifecycle attestation written: passed digest=${evidence.digest}\n`
      );
    } else {
      const agents = Object.keys(evidence.matrix).sort().join(",");
      process.stdout.write(
        `Live lifecycle evidence passed: version=${evidence.package.version} ` +
          `commit=${evidence.source.commit} matrix=${agents} digest=${evidence.digest}\n`
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      printUsageError();
      return EXIT_USAGE;
    }
    const code = safeFailureCode(error);
    process.stderr.write(`Live lifecycle evidence verification failed [${code}].\n`);
    return EXIT_VALIDATION;
  }
}

function parseArguments(argv) {
  const parsed = {
    help: false,
    inputKind: undefined,
    inputPath: undefined,
    expectedPackageName: undefined,
    expectedVersion: undefined,
    expectedCommit: undefined,
    requireMatrix: false,
    maxAgeHours: 72,
    outputPath: undefined
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      if (argv.length !== 1) {
        throw new UsageError("help cannot be combined with other arguments");
      }
      parsed.help = true;
      continue;
    }
    if (option === "--require-matrix") {
      rejectDuplicate(seen, option);
      parsed.requireMatrix = true;
      continue;
    }
    const valueOptions = new Set([
      "--evidence",
      "--attestation",
      "--expected-package-name",
      "--expected-version",
      "--expected-commit",
      "--max-age-hours",
      "--output"
    ]);
    if (!valueOptions.has(option)) {
      throw new UsageError("unknown argument");
    }
    rejectDuplicate(seen, option);
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new UsageError("missing option value");
    }
    index += 1;
    switch (option) {
      case "--evidence":
      case "--attestation":
        if (parsed.inputKind !== undefined) {
          throw new UsageError("input options are mutually exclusive");
        }
        parsed.inputKind = option === "--evidence" ? "evidence" : "attestation";
        parsed.inputPath = value;
        break;
      case "--expected-package-name":
        parsed.expectedPackageName = value;
        break;
      case "--expected-version":
        parsed.expectedVersion = value;
        break;
      case "--expected-commit":
        parsed.expectedCommit = value;
        break;
      case "--max-age-hours": {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours <= 0) {
          throw new UsageError("max age must be positive");
        }
        parsed.maxAgeHours = hours;
        break;
      }
      case "--output":
        parsed.outputPath = value;
        break;
    }
  }
  if (!parsed.help && (parsed.inputKind === undefined || parsed.inputPath === undefined)) {
    throw new UsageError("one input option is required");
  }
  return parsed;
}

function rejectDuplicate(seen, option) {
  if (seen.has(option)) {
    throw new UsageError("duplicate option");
  }
  seen.add(option);
}

function readPackageMetadata() {
  try {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(source);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.name !== "string" ||
      typeof parsed.version !== "string"
    ) {
      throw new Error("invalid package metadata");
    }
    return { name: parsed.name, version: parsed.version };
  } catch {
    throw new CliValidationError("package_metadata_unavailable");
  }
}

function readRepositoryCommit() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new CliValidationError("repository_commit_unavailable");
  }
  return commit;
}

function assertSafeExpectedValue(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new UsageError(`invalid expected ${label}`);
  }
}

function readBoundedText(inputPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(inputPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new Error("input is not a bounded regular file");
    }
    return fs.readFileSync(descriptor, "utf8");
  } catch {
    throw new CliValidationError("input_read_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The fixed error code above is sufficient; never echo OS error details.
      }
    }
  }
}

function writePrivateRegularFile(outputPath, contents) {
  let descriptor;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK;
  try {
    descriptor = fs.openSync(outputPath, flags, 0o600);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("output is not a regular file");
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } catch {
    throw new CliValidationError("output_write_failed");
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Do not expose the target path or OS error details.
      }
    }
  }
}

function safeFailureCode(error) {
  const candidate =
    error instanceof LiveLifecycleEvidenceValidationError ||
    error instanceof CliValidationError
      ? error.code
      : "verification_failed";
  return /^[a-z][a-z0-9_]{0,63}$/u.test(candidate)
    ? candidate
    : "verification_failed";
}

function printUsageError() {
  process.stderr.write("Invalid lifecycle evidence verifier arguments.\n");
  process.stderr.write(USAGE);
}

class CliValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

process.exitCode = main(process.argv.slice(2));

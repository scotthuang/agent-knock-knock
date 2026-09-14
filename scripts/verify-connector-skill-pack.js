#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  CANONICAL_SKILL_PATH,
  CONNECTOR_SKILL_ARTIFACTS,
  resolveRepositoryArtifactPath
} from "./sync-connector-skills.js";

const defaultRepoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Pack one fixed connector and prove its Skill member is the canonical bytes. */
export function verifyConnectorSkillPack({
  repoRoot = defaultRepoRoot,
  connector
} = {}) {
  const root = fs.realpathSync(path.resolve(repoRoot));
  const artifact = CONNECTOR_SKILL_ARTIFACTS.find(
    (candidate) => candidate.connector === connector
  );
  if (!artifact) throw new Error(`unknown connector ${String(connector)}`);
  const canonicalPath = resolveRepositoryArtifactPath(
    root,
    CANONICAL_SKILL_PATH,
    "canonical Skill"
  );
  const artifactPath = resolveRepositoryArtifactPath(
    root,
    artifact.path,
    `${artifact.connector} Skill artifact`
  );
  const packagePath = resolveRepositoryArtifactPath(
    root,
    `connectors/${artifact.connector}`,
    `${artifact.connector} package`
  );
  const canonicalBefore = requiredFile(canonicalPath, "canonical Skill");
  const artifactBefore = requiredFile(
    artifactPath,
    `${artifact.connector} Skill artifact`
  );
  if (!artifactBefore.equals(canonicalBefore)) {
    throw new Error(
      `${artifact.connector} Skill artifact does not match the canonical Skill`
    );
  }

  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), `akk-${artifact.connector}-pack-`)
  );
  try {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = spawnSync(
      npmCommand,
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        destination
      ],
      {
        cwd: packagePath,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    if (packed.error) {
      throw new Error(`npm pack failed to start: ${packed.error.message}`);
    }
    if (packed.status !== 0) {
      throw new Error(
        `npm pack failed: ${(packed.stderr || packed.stdout).trim()}`
      );
    }
    const report = parsePackReport(packed.stdout);
    const archivePath = safeArchivePath(destination, report.filename);
    const members = tarMembers(gunzipSync(requiredFile(archivePath, "npm pack archive")));
    const expectedMember = "package/skills/agent-knock-knock/SKILL.md";
    const skillMembers = members.filter((member) => member.path === expectedMember);
    if (skillMembers.length !== 1) {
      throw new Error(
        `${artifact.connector} package must contain exactly one ${expectedMember}`
      );
    }
    const canonicalAfter = requiredFile(canonicalPath, "canonical Skill");
    const artifactAfter = requiredFile(
      artifactPath,
      `${artifact.connector} Skill artifact`
    );
    if (
      !canonicalAfter.equals(canonicalBefore) ||
      !artifactAfter.equals(artifactBefore) ||
      !skillMembers[0].content.equals(canonicalBefore)
    ) {
      throw new Error(
        `${artifact.connector} packed Skill bytes do not match the canonical Skill`
      );
    }
    return Object.freeze({
      connector: artifact.connector,
      member: expectedMember,
      sha256: sha256(canonicalBefore)
    });
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

function parsePackReport(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("npm pack did not return JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    typeof parsed[0]?.filename !== "string" ||
    parsed[0].filename.length === 0
  ) {
    throw new Error("npm pack returned an invalid artifact report");
  }
  return parsed[0];
}

function safeArchivePath(directory, filename) {
  if (
    path.basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack returned an unsafe archive filename");
  }
  return path.join(directory, filename);
}

function tarMembers(archive) {
  const members = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const memberPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/u.test(sizeText)) {
      throw new Error(`npm pack archive has an invalid size for ${memberPath}`);
    }
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > archive.length) {
      throw new Error(`npm pack archive truncates ${memberPath}`);
    }
    members.push(Object.freeze({
      path: memberPath,
      content: archive.subarray(bodyStart, bodyEnd)
    }));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return members;
}

function tarString(value) {
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString("utf8");
}

function requiredFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return fs.readFileSync(filePath);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseInvocation(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--connector" ||
    !arguments_[1]
  ) {
    throw new Error(
      "usage: verify-connector-skill-pack --connector <pi|deepseek-harness>"
    );
  }
  return { connector: arguments_[1] };
}

function runCli() {
  try {
    const result = verifyConnectorSkillPack(parseInvocation(process.argv.slice(2)));
    process.stdout.write(
      `Verified ${result.connector} packaged Skill: ` +
      `sha256=${result.sha256}\n`
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
